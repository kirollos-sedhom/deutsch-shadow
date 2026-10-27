"""Unit tests for the German speech segmentation engine without requiring ML models."""

import unittest
from backend.app.audio.models import (
    Word,
    PracticeSegment,
    SegmentationConfig,
    TranscriptionResult,
)
from backend.app.audio.segmenter import GermanSegmenter


class TestGermanSegmenter(unittest.TestCase):
    """Test suite covering deterministic German speech segmentation."""

    def setUp(self):
        """Set up standard segmenter instance."""
        self.config = SegmentationConfig(
            min_duration_s=1.2,
            max_duration_s=7.0,
            target_duration_s=4.0,
            pause_split_threshold_s=0.6,
            lead_in_padding_s=0.08,
            tail_out_padding_s=0.08,
        )
        self.segmenter = GermanSegmenter(config=self.config)

    def test_empty_transcription(self):
        """Empty input must produce an empty segment list without error."""
        self.assertEqual(self.segmenter.segment([]), [])

        empty_result = TranscriptionResult(
            language="de",
            language_probability=0.99,
            duration_s=0.0,
            segments=[],
            all_words=[],
        )
        self.assertEqual(self.segmenter.segment(empty_result), [])

    def test_single_normal_sentence(self):
        """Normal German sentence should produce a single cleanly bounded segment."""
        # "Guten Tag, wie geht es Ihnen heute?" (Duration: 2.8s)
        words = [
            Word("Guten", 0.10, 0.45),
            Word("Tag,", 0.50, 0.85),
            Word("wie", 0.90, 1.15),
            Word("geht", 1.20, 1.50),
            Word("es", 1.52, 1.70),
            Word("Ihnen", 1.75, 2.10),
            Word("heute?", 2.15, 2.70),
        ]

        segments = self.segmenter.segment(words)
        self.assertEqual(len(segments), 1)

        seg = segments[0]
        self.assertEqual(seg.text, "Guten Tag, wie geht es Ihnen heute?")
        self.assertEqual(seg.sequence_index, 1)
        self.assertLess(seg.start_ms, int(0.10 * 1000))  # Lead-in padding applied
        self.assertGreater(seg.end_ms, int(2.70 * 1000))  # Tail-out padding applied
        self.assertEqual(len(seg.words), 7)

    def test_multiple_sentences_terminal_punctuation(self):
        """Multiple sentences ending with periods/exclamations must split cleanly."""
        # "Das ist ein Test. Wir lernen Deutsch! Geht das?"
        words = [
            Word("Das", 0.20, 0.50),
            Word("ist", 0.55, 0.75),
            Word("ein", 0.80, 0.95),
            Word("Test.", 1.00, 1.60),  # End of sentence 1 (duration: 1.4s >= min_duration)

            Word("Wir", 1.75, 2.00),
            Word("lernen", 2.05, 2.45),
            Word("Deutsch!", 2.50, 3.20),  # End of sentence 2 (duration: 1.45s)

            Word("Geht", 3.40, 3.70),
            Word("das?", 3.75, 4.80),  # End of sentence 3 (duration: 1.4s)
        ]

        segments = self.segmenter.segment(words)
        self.assertEqual(len(segments), 3)

        self.assertEqual(segments[0].text, "Das ist ein Test.")
        self.assertEqual(segments[1].text, "Wir lernen Deutsch!")
        self.assertEqual(segments[2].text, "Geht das?")

        # Check sequence indices
        for i, s in enumerate(segments):
            self.assertEqual(s.sequence_index, i + 1)

        # Check non-overlapping boundaries
        self.assertLessEqual(segments[0].end_ms, segments[1].start_ms)
        self.assertLessEqual(segments[1].end_ms, segments[2].start_ms)

    def test_german_abbreviations_do_not_split(self):
        """Known abbreviations like 'z. B.' or 'ca.' must not trigger false sentence splits."""
        # "Wir treffen uns z. B. morgen um zehn Uhr."
        words = [
            Word("Wir", 0.10, 0.35),
            Word("treffen", 0.40, 0.80),
            Word("uns", 0.85, 1.05),
            Word("z.", 1.10, 1.25),
            Word("B.", 1.30, 1.50),
            Word("morgen", 1.55, 1.95),
            Word("um", 2.00, 2.15),
            Word("zehn", 2.20, 2.55),
            Word("Uhr.", 2.60, 3.10),
        ]

        segments = self.segmenter.segment(words)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].text, "Wir treffen uns z. B. morgen um zehn Uhr.")

    def test_long_sentence_split_at_clause(self):
        """Sentences exceeding target duration must split at clause punctuation (, ; : —)."""
        # Long sentence: 5.6s with comma after 4.2s
        words = [
            Word("Ich", 0.0, 0.3),
            Word("habe", 0.35, 0.7),
            Word("gestern", 0.75, 1.3),
            Word("sehr", 1.35, 1.7),
            Word("lange", 1.75, 2.2),
            Word("in", 2.25, 2.4),
            Word("der", 2.45, 2.6),
            Word("Bibliothek", 2.65, 3.5),
            Word("gelernt,", 3.55, 4.3),  # Clause punctuation at 4.3s >= target 4.0s

            Word("weil", 4.4, 4.7),
            Word("die", 4.75, 4.9),
            Word("Prüfung", 4.95, 5.5),
            Word("schwer", 5.55, 5.9),
            Word("ist.", 5.95, 6.4),
        ]

        segments = self.segmenter.segment(words)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0].text, "Ich habe gestern sehr lange in der Bibliothek gelernt,")
        self.assertEqual(segments[1].text, "weil die Prüfung schwer ist.")

    def test_acoustic_pause_split(self):
        """Gaps between words exceeding pause_split_threshold_s must trigger a boundary."""
        # Two phrases without terminal punctuation, separated by 0.8s silence
        words = [
            Word("Erste", 0.1, 0.6),
            Word("Phrase", 0.65, 1.4),  # ends at 1.4s
            # Pause: 1.4s to 2.25s (duration: 0.85s >= 0.6s)
            Word("Zweite", 2.25, 2.8),
            Word("Phrase", 2.85, 3.8),
        ]

        segments = self.segmenter.segment(words)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0].text, "Erste Phrase")
        self.assertEqual(segments[1].text, "Zweite Phrase")

    def test_hard_overflow_protection(self):
        """Speech run exceeding max_duration_s with no punctuation must split gracefully."""
        # 20 words across 9.5 seconds without any punctuation
        words = []
        for i in range(20):
            start = i * 0.48
            end = start + 0.42
            words.append(Word(f"Wort{i+1}", start, end))

        segments = self.segmenter.segment(words)
        self.assertGreater(len(segments), 1)

        # All words must be preserved exactly
        reconstructed_words = [w.word for s in segments for w in s.words]
        original_words = [w.word for w in words]
        self.assertEqual(reconstructed_words, original_words)

        # No segment should exceed max_duration + padding
        max_allowed_ms = int((self.config.max_duration_s + 0.5) * 1000)
        for s in segments:
            self.assertLessEqual(s.duration_ms, max_allowed_ms)

    def test_missing_or_noisy_timestamps(self):
        """Words with slightly out-of-order or flat timestamps are sanitized safely."""
        words = [
            Word("Eins", 0.0, 0.0),    # zero duration
            Word("Zwei", 0.5, 0.4),    # end < start
            Word("Drei.", 0.6, 1.5),
        ]

        segments = self.segmenter.segment(words)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].text, "Eins Zwei Drei.")
        self.assertGreater(segments[0].end_ms, segments[0].start_ms)

    def test_dialogue_quotes_and_question_marks(self):
        """German dialogue quotes like „Hallo!“ must be kept with their words."""
        words = [
            Word("„Hallo!“", 0.2, 1.4),
            Word("sagte", 1.6, 2.0),
            Word("der", 2.05, 2.2),
            Word("Mann.", 2.25, 2.8),
        ]

        segments = self.segmenter.segment(words)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0].text, "„Hallo!“")
        self.assertEqual(segments[1].text, "sagte der Mann.")


if __name__ == "__main__":
    unittest.main()
