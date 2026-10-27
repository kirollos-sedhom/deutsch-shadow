"""Deterministic German speech segmentation module for listening and shadowing."""

from __future__ import annotations
import re
from typing import List, Optional

from backend.app.audio.models import (
    Word,
    PracticeSegment,
    SegmentationConfig,
    TranscriptionResult,
)

# Common German abbreviations that should not trigger sentence terminal splitting
GERMAN_ABBREVIATIONS = {
    "z.b.", "bzw.", "ca.", "d.h.", "u.a.", "usw.", "dr.", "prof.",
    "hr.", "fr.", "nr.", "str.", "inkl.", "evtl.", "vgl.", "etc.",
    "mrd.", "mio.", "abs.", "art.", "st.", "ab.", "v.", "u.",
    "z.", "b.", "d.", "h.", "a.", "e.", "s.",
}

# Single letter with period, e.g. "z." or "B." or middle initials
SINGLE_LETTER_ABBREV = re.compile(r"^[a-zA-ZäöüÄÖÜß]\.$")

# Terminal sentence punctuation followed by optional quotes/brackets
# Includes German typographical closing quotes: “ (U+201C), ” (U+201D), ‘ (U+2018), ’ (U+2019), », «, etc.
TERMINAL_PUNCTUATION = re.compile(r"[\.!\?][\"'»«”’“‘›‹\)]*$")

# Clause boundary punctuation followed by optional quotes/brackets
CLAUSE_PUNCTUATION = re.compile(r"[,;:\—\-][\"'»«”’“‘›‹\)]*$")


class GermanSegmenter:
    """Partitions transcribed words into pedagogically effective shadowing segments."""

    def __init__(self, config: Optional[SegmentationConfig] = None):
        """Initialize segmenter with configurable rules."""
        self.config = config or SegmentationConfig()

    def segment(
        self,
        transcription_or_words: TranscriptionResult | List[Word],
        media_duration_s: Optional[float] = None,
    ) -> List[PracticeSegment]:
        """Split recognized words into natural German shadowing segments.

        Args:
            transcription_or_words: TranscriptionResult or list of Word objects.
            media_duration_s: Total duration of the source recording in seconds,
                used to safely clamp trailing segment boundaries.

        Returns:
            List of PracticeSegment objects with millisecond timestamps and word arrays.
        """
        if isinstance(transcription_or_words, TranscriptionResult):
            words = transcription_or_words.all_words
        else:
            words = transcription_or_words

        if not words:
            return []

        # Sanitize and ensure timestamps are non-decreasing
        clean_words = self._sanitize_words(words)
        if not clean_words:
            return []

        # Group words into raw segment chunks based on syntax and pauses
        word_chunks = self._chunk_words(clean_words)

        # Convert word chunks into PracticeSegments with boundary padding
        practice_segments: List[PracticeSegment] = []
        last_end_ms = 0
        max_allowed_ms = int(round(self.config.max_duration_s * 1000))

        for seq_idx, chunk in enumerate(word_chunks):
            if not chunk:
                continue

            first_word = chunk[0]
            last_word = chunk[-1]

            # Calculate raw millisecond boundaries
            raw_start_ms = first_word.start_ms
            raw_end_ms = last_word.end_ms

            # Apply acoustic padding
            lead_in_ms = int(round(self.config.lead_in_padding_s * 1000))
            tail_out_ms = int(round(self.config.tail_out_padding_s * 1000))

            padded_start_ms = max(0, raw_start_ms - lead_in_ms)
            padded_end_ms = raw_end_ms + tail_out_ms

            # Clamp trailing boundary to media duration if provided
            if media_duration_s is not None and media_duration_s > 0:
                media_end_ms = int(round(media_duration_s * 1000))
                padded_end_ms = min(padded_end_ms, media_end_ms)

            # Prevent overlap with previous segment
            if padded_start_ms < last_end_ms:
                padded_start_ms = max(last_end_ms, raw_start_ms)

            # Ensure start < end
            if padded_end_ms <= padded_start_ms:
                padded_end_ms = padded_start_ms + max(100, last_word.duration_ms)
                if media_duration_s is not None and media_duration_s > 0:
                    media_end_ms = int(round(media_duration_s * 1000))
                    padded_end_ms = min(padded_end_ms, media_end_ms)
                    padded_start_ms = min(padded_start_ms, max(0, padded_end_ms - 100))

            # Strictly enforce the playable maximum duration limit
            seg_duration_ms = padded_end_ms - padded_start_ms
            if seg_duration_ms > max_allowed_ms:
                excess_ms = seg_duration_ms - max_allowed_ms
                # Trim excess from tail padding first
                if padded_end_ms > raw_end_ms:
                    tail_trim = min(excess_ms, padded_end_ms - raw_end_ms)
                    padded_end_ms -= tail_trim
                    excess_ms -= tail_trim
                # Trim excess from lead-in padding next
                if excess_ms > 0 and padded_start_ms < raw_start_ms:
                    lead_trim = min(excess_ms, raw_start_ms - padded_start_ms)
                    padded_start_ms += lead_trim
                    excess_ms -= lead_trim
                # Hard clamp if still over
                if padded_end_ms - padded_start_ms > max_allowed_ms:
                    padded_end_ms = padded_start_ms + max_allowed_ms

            # Reconstruct clean text representation
            text = " ".join(w.word for w in chunk).strip()

            segment = PracticeSegment(
                id=seq_idx + 1,
                sequence_index=seq_idx + 1,
                start_ms=padded_start_ms,
                end_ms=padded_end_ms,
                text=text,
                duration_ms=padded_end_ms - padded_start_ms,
                words=chunk,
            )
            practice_segments.append(segment)
            last_end_ms = padded_end_ms

        return practice_segments

    def _sanitize_words(self, words: List[Word]) -> List[Word]:
        """Ensure all words have valid text and non-negative timestamps."""
        sanitized: List[Word] = []
        current_time = 0.0

        for w in words:
            w_text = w.word.strip()
            if not w_text:
                continue

            start_s = max(current_time, float(w.start_s))
            end_s = max(start_s, float(w.end_s))

            sanitized.append(
                Word(
                    word=w_text,
                    start_s=start_s,
                    end_s=end_s,
                    probability=w.probability,
                )
            )
            current_time = start_s

        return sanitized

    def _is_abbreviation(self, word: str) -> bool:
        """Check if a word is a known German abbreviation or single letter initial."""
        cleaned = word.lower().strip().strip("\"'»«”’“‘›‹()")
        if cleaned in GERMAN_ABBREVIATIONS:
            return True
        if SINGLE_LETTER_ABBREV.match(cleaned):
            return True
        return False

    def _chunk_words(self, words: List[Word]) -> List[List[Word]]:
        """Partition word list into logical segment groups."""
        chunks: List[List[Word]] = []
        current_chunk: List[Word] = []

        total_words = len(words)
        total_padding_s = self.config.lead_in_padding_s + self.config.tail_out_padding_s
        max_speech_s = max(self.config.min_duration_s, self.config.max_duration_s - total_padding_s)

        for i, word in enumerate(words):
            current_chunk.append(word)

            is_last_word = (i == total_words - 1)
            if is_last_word:
                break

            next_word = words[i + 1]

            # Calculate metrics
            chunk_start_s = current_chunk[0].start_s
            chunk_duration = round(word.end_s - chunk_start_s, 3)
            pause_after = round(max(0.0, next_word.start_s - word.end_s), 3)
            projected_dur_with_next = round(next_word.end_s - chunk_start_s, 3)

            should_split = False

            # Check 1: Terminal German sentence punctuation (. ! ?)
            is_terminal = bool(TERMINAL_PUNCTUATION.search(word.word))
            if is_terminal and not self._is_abbreviation(word.word):
                if chunk_duration >= self.config.min_duration_s:
                    should_split = True
                elif pause_after >= 0.2:
                    should_split = True

            # Check 2: Significant acoustic pause between words (>= pause_split_threshold_s)
            if not should_split and pause_after >= self.config.pause_split_threshold_s:
                if chunk_duration >= self.config.min_duration_s:
                    should_split = True

            # Check 3: Clause punctuation (, ; : —) when exceeding target duration
            if not should_split and chunk_duration >= self.config.target_duration_s:
                is_clause = bool(CLAUSE_PUNCTUATION.search(word.word))
                if is_clause or pause_after >= 0.25:
                    should_split = True

            # Check 4: Hard overflow protection (adding next word would exceed max speech duration)
            if not should_split and chunk_duration >= self.config.min_duration_s:
                if projected_dur_with_next > max_speech_s:
                    should_split = True

            if should_split:
                chunks.append(current_chunk)
                current_chunk = []

        if current_chunk:
            # If the final trailing chunk is extremely short (< min_duration) and we have prior chunks,
            # only merge into the previous chunk if the combined duration does not exceed max_speech_s.
            chunk_dur = round(current_chunk[-1].end_s - current_chunk[0].start_s, 3)
            if chunks and chunk_dur < self.config.min_duration_s:
                combined_dur = round(current_chunk[-1].end_s - chunks[-1][0].start_s, 3)
                if combined_dur <= max_speech_s:
                    chunks[-1].extend(current_chunk)
                else:
                    chunks.append(current_chunk)
            else:
                chunks.append(current_chunk)

        return chunks
