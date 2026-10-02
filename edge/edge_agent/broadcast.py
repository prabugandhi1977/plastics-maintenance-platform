"""Factory-network alarm broadcast for life-safety events (fire, smoke, intrusion).

A signed JSON datagram goes to a UDP multicast group on the factory subnet, three times 50 ms apart (UDP can
drop). Screens, PA gateways, fire-panel interfaces and the platform's on-site relays subscribe to the group.
This needs no server and no internet, so it reaches the floor in milliseconds even when the uplink is down,
well inside the 2-second requirement. Receivers verify the HMAC with the shared site secret and ignore
duplicates by alarm id.
"""
import hashlib
import hmac
import json
import socket
import struct
import time

VERSION = 1


def packet(alarm, secret):
    body = {"v": VERSION, **alarm}
    raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return json.dumps({"alarm": body, "sig": sig}, separators=(",", ":")).encode()


def verify(data, secret):
    """Returns the alarm dict when the signature is valid, else None."""
    try:
        msg = json.loads(data)
        raw = json.dumps(msg["alarm"], sort_keys=True, separators=(",", ":")).encode()
        good = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        return msg["alarm"] if hmac.compare_digest(good, msg["sig"]) else None
    except (ValueError, KeyError, TypeError):
        return None


def send(alarm, secret, group="239.10.10.10", port=5005, repeats=3, ttl=4):
    """Sends the alarm; returns milliseconds until the first datagram left the socket."""
    start = time.perf_counter()
    data = packet(alarm, secret)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
    first = None
    try:
        for i in range(repeats):
            s.sendto(data, (group, port))
            if first is None:
                first = (time.perf_counter() - start) * 1000
            if i < repeats - 1:
                time.sleep(0.05)
    finally:
        s.close()
    return round(first, 1)


def listen(secret, group="239.10.10.10", port=5005, on_alarm=print):
    """Example receiver for a wall screen, PA gateway or fire-panel interface."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("", port))
    s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, struct.pack("4sl", socket.inet_aton(group), socket.INADDR_ANY))
    seen = set()
    while True:
        data, _ = s.recvfrom(65535)
        alarm = verify(data, secret)
        if alarm and alarm.get("id") not in seen:
            seen.add(alarm.get("id"))
            on_alarm(alarm)
