"""Physical outputs on the factory floor (entrance beacons, sirens, PLC OK/NG signals) and the PLC inputs the
quality station reads (part-present trigger).

Modbus TCP (Write Single Coil 0x05, Read Coils 0x01, Read Discrete Inputs 0x02) is implemented here on a plain
socket, so a reject reaches the PLC with no library overhead. EtherNet/IP uses pycomm3 when installed (CIP
explicit messaging to a tag) over one connection kept open per PLC.
GPIO uses the Linux character device through `gpioset` (libgpiod), and HTTP relays a simple request.
Every output records how long it took, which goes to the platform as part of the incident.
"""
import socket
import struct
import subprocess
import threading
import time
import urllib.request

_tid = 0
_tid_lock = threading.Lock()


def modbus_write_coil_frame(unit_id, coil, on, transaction_id):
    """MBAP header + PDU for Write Single Coil (0x05): value 0xFF00 = on, 0x0000 = off."""
    pdu = struct.pack(">BHH", 0x05, coil, 0xFF00 if on else 0x0000)
    return struct.pack(">HHHB", transaction_id, 0, len(pdu) + 1, unit_id) + pdu


def modbus_read_bits_frame(unit_id, function, address, count, transaction_id):
    """MBAP header + PDU for Read Coils (0x01) or Read Discrete Inputs (0x02)."""
    pdu = struct.pack(">BHH", function, address, count)
    return struct.pack(">HHHB", transaction_id, 0, len(pdu) + 1, unit_id) + pdu


def parse_read_bits_reply(reply, function, count):
    """Bits from a Read Coils / Read Discrete Inputs reply (least significant bit first)."""
    if len(reply) < 9 or reply[7] != function:
        raise IOError(f"Modbus exception reply: {reply.hex()}")
    data = reply[9:9 + reply[8]]
    return [bool(data[i // 8] >> (i % 8) & 1) for i in range(count)]


def _next_tid():
    global _tid
    with _tid_lock:
        _tid = (_tid + 1) % 65536
        return _tid


class ModbusTcp:
    """A persistent connection to one PLC or I/O module, with a short timeout and one reconnect attempt."""

    def __init__(self, host, port=502, timeout=0.2):
        self.host, self.port, self.timeout = host, port, timeout
        self.sock = None
        self.lock = threading.Lock()

    def _connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def write_coil(self, unit_id, coil, on):
        frame = modbus_write_coil_frame(unit_id, coil, on, _next_tid())
        with self.lock:
            for attempt in range(2):
                try:
                    if self.sock is None:
                        self._connect()
                    self.sock.sendall(frame)
                    reply = self.sock.recv(12)
                    if len(reply) < 9 or reply[7] & 0x80:
                        raise IOError(f"Modbus exception reply: {reply.hex()}")
                    return
                except (OSError, IOError):
                    if self.sock:
                        self.sock.close()
                    self.sock = None
                    if attempt:
                        raise

    def read_bits(self, unit_id, function, address, count=1):
        """Function 0x01 (coils) or 0x02 (discrete inputs)."""
        frame = modbus_read_bits_frame(unit_id, function, address, count, _next_tid())
        with self.lock:
            for attempt in range(2):
                try:
                    if self.sock is None:
                        self._connect()
                    self.sock.sendall(frame)
                    reply = self.sock.recv(9 + (count + 7) // 8)
                    return parse_read_bits_reply(reply, function, count)
                except (OSError, IOError):
                    if self.sock:
                        self.sock.close()
                    self.sock = None
                    if attempt:
                        raise


_modbus = {}
_eip = {}
_eip_lock = threading.Lock()


def _modbus_client(host, port=502):
    return _modbus.setdefault((host, port), ModbusTcp(host, port))


def _eip_driver(host):
    """One open EtherNet/IP session per PLC: opening a CIP connection takes tens of milliseconds."""
    with _eip_lock:
        drv = _eip.get(host)
        if drv is None or not drv.connected:
            from pycomm3 import LogixDriver  # optional dependency: pip install pycomm3
            drv = LogixDriver(host)
            drv.open()
            _eip[host] = drv
        return drv


def _eip_call(host, fn):
    try:
        return fn(_eip_driver(host))
    except Exception:
        with _eip_lock:                  # reconnect once: the PLC may have dropped the session
            old = _eip.pop(host, None)
        if old:
            try:
                old.close()
            except Exception:
                pass
        return fn(_eip_driver(host))


def read_input(inp):
    """Reads a PLC input such as the part-present signal; returns True/False.
    Modbus: {"protocol":"modbus_tcp","host","port","unitId","kind":"discrete_input"|"coil","address"};
    EtherNet/IP: {"protocol":"ethernet_ip","host","tag"}."""
    if inp["protocol"] == "modbus_tcp":
        client = _modbus_client(inp["host"], inp.get("port", 502))
        fn = 0x01 if inp.get("kind") == "coil" else 0x02
        return client.read_bits(inp.get("unitId", 1), fn, inp.get("address", 0))[0]
    if inp["protocol"] == "ethernet_ip":
        res = _eip_call(inp["host"], lambda plc: plc.read(inp["tag"]))
        if getattr(res, "error", None):
            raise IOError(f"EtherNet/IP read {inp['tag']}: {res.error}")
        return bool(res.value)
    raise ValueError(f"Unknown input protocol {inp['protocol']}")


def fire(output, on_done=None):
    """Activates an output for its pulse length without blocking the caller. Returns the milliseconds the
    activation itself took (the signal is on the wire by then); the release happens in the background."""
    if not output:
        return None
    start = time.perf_counter()
    proto = output["protocol"]
    if proto == "modbus_tcp":
        client = _modbus_client(output["host"], output.get("port", 502))
        client.write_coil(output.get("unitId", 1), output.get("coil", 0), True)
        release = lambda: client.write_coil(output.get("unitId", 1), output.get("coil", 0), False)
    elif proto == "ethernet_ip":
        _eip_write(output["host"], output["tag"], output.get("value", 1))
        release = lambda: _eip_write(output["host"], output["tag"], 0)
    elif proto == "gpio":
        level = "1" if output.get("activeHigh", True) else "0"
        subprocess.run(["gpioset", "gpiochip0", f"{output['pin']}={level}"], check=True, timeout=1)
        release = lambda: subprocess.run(["gpioset", "gpiochip0", f"{output['pin']}={'0' if level == '1' else '1'}"], check=False, timeout=1)
    elif proto == "http":
        urllib.request.urlopen(output["url"], timeout=1).read()
        release = None
    else:
        raise ValueError(f"Unknown output protocol {proto}")
    elapsed = (time.perf_counter() - start) * 1000
    if release:
        threading.Timer(output.get("pulseMs", 500) / 1000, _safe(release)).start()
    if on_done:
        on_done(elapsed)
    return round(elapsed, 1)


def _eip_write(host, tag, value):
    res = _eip_call(host, lambda plc: plc.write((tag, value)))
    if getattr(res, "error", None):
        raise IOError(f"EtherNet/IP write {tag}: {res.error}")


def _safe(fn):
    def run():
        try:
            fn()
        except Exception as e:  # releasing must never crash the agent; the PLC watchdog clears stuck outputs
            print(f"Output release failed: {e}")
    return run
