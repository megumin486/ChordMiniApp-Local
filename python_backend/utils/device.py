"""Device selection for the local-only build.

Everything here runs on the machine it was installed on, so the compute device
should be the operator's choice -- not a side effect of another environment
variable. Historically it was a side effect: ``beat_transformer.py`` looked for
a ``DeviceManager`` that does not exist in this tree and, failing that, enabled
GPU only when ``is_local_development()`` returned true. That helper treats an
exported ``PORT`` as a Google Cloud Run deployment, and ``start.sh`` exports
``PORT`` on purpose, so a machine with a perfectly good GPU still ran on CPU,
with no way to opt in.

The choice is now explicit and configurable:

    CHORDMINI_DEVICE=cpu      default; identical behaviour to before
    CHORDMINI_DEVICE=auto     CUDA if available, then Apple MPS, then CPU
    CHORDMINI_DEVICE=cuda     CUDA device 0 (needs a CUDA build of torch)
    CHORDMINI_DEVICE=cuda:1   any other CUDA device index
    CHORDMINI_DEVICE=mps      Apple Silicon GPU

Unset means CPU, so a fresh clone keeps the tested path. An unavailable or
mistyped value falls back to CPU with a single warning instead of taking the
backend down, and nothing is ever forced: no ``CUDA_VISIBLE_DEVICES`` games.

Note on the chord models: BTC loading happens inside the ChordMini submodule,
which picks its own device when the backend calls it. This module governs the
models the backend instantiates itself (the Beat Transformer today).
"""

from __future__ import annotations

import os
import sys

import torch

ENV_VAR = "CHORDMINI_DEVICE"
VALID_CHOICES = ("cpu", "auto", "cuda", "mps")

# One warning per distinct message: a bad value should be reported once, not
# once per request.
_warned: set[str] = set()


def _warn(message: str) -> None:
    if message in _warned:
        return
    _warned.add(message)
    print(f"[device] {message}", file=sys.stderr)


def _verbose_default() -> bool:
    return (
        os.environ.get("FLASK_ENV") == "development"
        or os.environ.get("DEBUG", "false").lower() == "true"
    )


def _mps_available() -> bool:
    backend = getattr(torch.backends, "mps", None)
    try:
        return bool(backend and backend.is_available())
    except Exception:  # pragma: no cover - platform-specific probing
        return False


def _cuda_device(index: int) -> torch.device | None:
    """Return ``cuda:<index>`` only when a kernel can actually run there.

    ``torch.cuda.is_available()`` (and the reported capability) can be true on
    a card this torch build has no kernels for -- e.g. Blackwell sm_120 with
    torch 2.6: the driver enumerates the GPU, but every real op raises "no
    kernel image is available for execution on the device". A one-element
    kernel probe is the only honest check, and it is cheap.
    """
    try:
        if not torch.cuda.is_available():
            return None
        if index < 0 or index >= torch.cuda.device_count():
            return None
        probe = torch.zeros(1, device=f"cuda:{index}")
        (probe + 1).sum().item()
        torch.cuda.synchronize(index)
        del probe
        torch.cuda.empty_cache()
    except Exception:
        return None
    return torch.device(f"cuda:{index}")


def _report(device: torch.device, component: str, why: str) -> torch.device:
    return device, why


def resolve_device(component: str = "models", verbose: bool | None = None) -> torch.device:
    """Resolve the compute device for ``component`` from CHORDMINI_DEVICE.

    Falls back to CPU for anything unavailable, unknown or malformed, and
    never raises: the app must still start on a machine without a GPU.
    """
    want = (os.environ.get(ENV_VAR) or "cpu").strip().lower()
    verbose = _verbose_default() if verbose is None else verbose

    device: torch.device
    why: str

    if want == "cpu":
        device, why = torch.device("cpu"), "default (unset)"
    elif want == "auto":
        cuda = _cuda_device(0)
        if cuda is not None:
            device, why = cuda, "auto -> CUDA is available"
        elif _mps_available():
            device, why = torch.device("mps"), "auto -> MPS is available"
        else:
            device, why = torch.device("cpu"), "auto -> no usable GPU, CPU"
    elif want.startswith("cuda"):
        index = 0
        if ":" in want:
            raw_index = want.split(":", 1)[1]
            try:
                index = int(raw_index)
            except ValueError:
                _warn(
                    f"{ENV_VAR}={want!r}: {raw_index!r} is not a device index "
                    f"(try cuda or cuda:0); falling back to CPU"
                )
                device, why = torch.device("cpu"), "invalid CUDA index, CPU"
                index = -1
        if index >= 0:
            cuda = _cuda_device(index)
            if cuda is not None:
                device, why = cuda, f"CUDA device {index}"
            else:
                _warn(
                    f"{ENV_VAR}={want!r}: CUDA device {index} cannot run kernels here "
                    f"(torch.cuda.is_available() -> {torch.cuda.is_available()}; "
                    f"needs a CUDA build of torch that supports this GPU's compute "
                    f"capability); falling back to CPU"
                )
                device, why = torch.device("cpu"), "CUDA unavailable, CPU"
    elif want == "mps":
        if _mps_available():
            device, why = torch.device("mps"), "MPS"
        else:
            _warn(f"{ENV_VAR}='mps': Apple MPS is not available here; falling back to CPU")
            device, why = torch.device("cpu"), "MPS unavailable, CPU"
    else:
        _warn(
            f"{ENV_VAR}={want!r} is not one of {', '.join(VALID_CHOICES)}; "
            f"falling back to CPU"
        )
        device, why = torch.device("cpu"), "unknown value, CPU"

    if verbose:
        print(f"[device] {component}: {device.type} ({why})")
    return device
