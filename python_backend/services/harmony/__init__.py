"""Music-theory rule engine (Phase 1).

A local implementation replacing four capabilities that originally used Gemini:
  - key detection (item 11)
  - roman numeral analysis (item 13)
  - modulation marking (item 14)
  - chord spelling correction (item 15)

See FEATURE_SCOPE 6.1 and 11.2 for the design rationale.
"""

from services.harmony.chord_normalizer import (
    denormalize_chord,
    is_no_chord,
    normalize_chord,
    to_plain_chord_name,
)
from services.harmony.enharmonic import (
    correct_chord,
    correct_sequence,
    key_preference,
)
from services.harmony.key_detector import (
    detect_key,
    detect_key_heuristic,
    detect_key_music21,
)
from services.harmony.modulation import build_sections, detect_modulations
from services.harmony.roman_analyzer import (
    analyze_sequence,
    analyze_sequence_with_scores,
    chord_to_roman,
    is_diatonic,
    make_key_object,
)

__all__ = [
    # normalization
    "normalize_chord",
    "is_no_chord",
    "to_plain_chord_name",
    "denormalize_chord",
    # key detection
    "detect_key",
    "detect_key_heuristic",
    "detect_key_music21",
    # roman numerals
    "analyze_sequence",
    "analyze_sequence_with_scores",
    "chord_to_roman",
    "is_diatonic",
    "make_key_object",
    # spelling correction
    "correct_chord",
    "correct_sequence",
    "key_preference",
    # modulation
    "detect_modulations",
    "build_sections",
]
