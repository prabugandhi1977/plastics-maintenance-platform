"""Reference edge agent for the Vision AI platform.

Runs on the industrial GPU PC next to the cameras. It decodes the camera streams, runs the AI models
(NVIDIA DeepStream / TensorRT in production), decides locally (PPE, fire and smoke, restricted areas,
quality), acts locally (beacons, sirens, PLC rejects, factory-network broadcast) and then reports to the
platform with evidence. Everything except the GPU pipeline is standard-library Python and unit-tested.
"""
__version__ = "1.0.0"
