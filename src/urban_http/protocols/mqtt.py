"""Adaptateur MQTT / MQTTS : publier un message ou lire le premier message reçu,
via paho-mqtt (extra PyPI : pip install "urban-http[mqtt]").
Client injectable via ctx.client_factory (tests).
"""
from __future__ import annotations

from typing import List

from .types import ProtocolContext, ProtocolRequest, ProtocolResult


class _DefaultMqttClient:
    def __init__(self, req: ProtocolRequest):
        self._req = req
        self._client = None

    def connect(self):
        try:
            import paho.mqtt.client as mqtt
        except ImportError as e:
            raise RuntimeError('MQTT nécessite paho-mqtt : pip install "urban-http[mqtt]"') from e
        req = self._req
        client = mqtt.Client()
        if req.username:
            client.username_pw_set(req.username, req.password or "")
        if req.secure:
            import ssl as ssl_mod
            client.tls_set_context(ssl_mod._create_unverified_context() if req.insecure else ssl_mod.create_default_context())
        client.connect(req.host, req.port, keepalive=60)
        client.loop_start()
        self._client = client

    def publish(self, topic: str, payload: bytes, qos: int, retain: bool):
        info = self._client.publish(topic, payload, qos=qos, retain=retain)
        info.wait_for_publish(timeout=10)

    def subscribe_one(self, topic: str, qos: int, timeout_ms: int) -> bytes:
        import queue
        received: "queue.Queue[bytes]" = queue.Queue()
        self._client.on_message = lambda c, u, msg: received.put(msg.payload)
        self._client.subscribe(topic, qos=qos)
        try:
            return received.get(timeout=timeout_ms / 1000)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f'Aucun message MQTT reçu sur "{topic}" dans le délai imparti.') from e

    def close(self):
        if self._client:
            self._client.loop_stop()
            self._client.disconnect()


class _MqttAdapter:
    name = "mqtt"
    schemes = ["mqtt", "mqtts"]

    def execute(self, req: ProtocolRequest, ctx: ProtocolContext) -> ProtocolResult:
        issues: List[str] = []
        topic = req.path.lstrip("/")
        if not topic:
            raise ValueError("MQTT : aucun topic dans l'URL (mqtt://courtier/mon/topic).")
        client = ctx.client_factory() if ctx.client_factory else _DefaultMqttClient(req)
        client.connect()
        qos = req.mqtt.qos if req.mqtt else 0
        retain = req.mqtt.retain if req.mqtt else False
        try:
            if req.direction == "publish":
                payload = (req.payload.text or "").encode() if req.payload else b""
                client.publish(topic, payload, qos, retain)
                return ProtocolResult(scheme=req.scheme, ok=True, summary=f'Message publié sur "{topic}" ({len(payload)} octets)', meta={"topic": topic, "bytes": len(payload), "qos": qos, "retain": retain}, issues=issues)

            issues.append("Abonnement : le SDK lit le premier message reçu puis se déconnecte.")
            body = client.subscribe_one(topic, qos, req.timeout_ms or 30000)
            if req.output and req.output != "-" and ctx.write_file:
                ctx.write_file(req.output, body)
            return ProtocolResult(scheme=req.scheme, ok=True, summary=f'Message reçu sur "{topic}" ({len(body)} octets)', body=body, meta={"topic": topic, "bytes": len(body)}, issues=issues)
        finally:
            client.close()


mqtt_adapter = _MqttAdapter()
