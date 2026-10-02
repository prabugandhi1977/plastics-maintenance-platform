"""Physical outputs on the factory floor: entrance beacons, sirens, PLC reject signals.

Modbus TCP (Write Single Coil, function 0x05) is implemented here on a plain socket, so a reject reaches the
PLC with no library overhead. EtherNet/IP uses pycomm3 when installed (CIP explicit messaging to a tag).
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


_modbus = {}


def fire(output, on_done=None):
    """Activates an output for its pulse length without blocking the caller. Returns the milliseconds the
    activation itself took (the signal is on the wire by then); the release happens in the background."""
    if not output:
        return None
    start = time.perf_counter()
    proto = output["protocol"]
    if proto == "modbus_tcp":
        key = (output["host"], output.get("port", 502))
        client = _modbus.setdefault(key, ModbusTcp(*key))
        client.write_coil(output.get("unitId", 1), output.get("coil", 0), True)
        release = lambda: client.write_coil(output.get("unitId", 1), output.get("coil", 0), False)
    elif proto == "ethernet_ip":
        from pycomm3 import LogixDriver  # optional dependency: pip install pycomm3
        with LogixDriver(output["host"]) as plc:
            plc.write((output["tag"], output.get("value", 1)))
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
    from pycomm3 import LogixDriver
    with LogixDriver(host) as plc:
        plc.write((tag, value))


def _safe(fn):
    def run():
        try:
            fn()
        except Exception as e:  # releasing must never crash the agent; the PLC watchdog clears stuck outputs
            print(f"Output release failed: {e}")
    return run
