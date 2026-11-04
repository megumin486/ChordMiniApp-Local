import { createTimeToNormalizedX } from '@/components/piano-visualizer/ScrollingChordStrip';
import type { ChordEvent } from '@/utils/chordToMidi';

function event(beatIndex: number, startTime: number, endTime: number): ChordEvent {
  return {
    chord: 'C',
    startTime,
    endTime,
    beatIndex,
    beatCount: 1,
    normalizedChord: 'C',
  } as ChordEvent;
}

/** Uniform 0.3 s beats, the shape a real beat grid produces. */
function contiguousEvents(count: number): ChordEvent[] {
  const events: ChordEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push(event(i, i * 0.3, (i + 1) * 0.3));
  }
  return events;
}

function sample(mapping: (t: number) => number, from: number, to: number, step: number): number[] {
  const values: number[] = [];
  for (let t = from; t <= to; t += step) values.push(mapping(t));
  return values;
}

describe('createTimeToNormalizedX', () => {
  it('is strictly forward-monotonic over a contiguous beat grid', () => {
    const mapping = createTimeToNormalizedX(contiguousEvents(40), 118, 4);
    const values = sample(mapping, 0, 12, 0.02);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('has no discontinuity at beat boundaries', () => {
    const mapping = createTimeToNormalizedX(contiguousEvents(40), 118, 4);
    for (let beat = 1; beat < 39; beat += 1) {
      const boundary = beat * 0.3;
      const before = mapping(boundary - 1e-4);
      const after = mapping(boundary + 1e-4);
      // 1e-4 s at 120 px/s is 0.012 px, so anything larger is a real jump.
      expect(Math.abs(after - before)).toBeLessThan(0.05);
    }
  });

  it('stays inside the cell range when beats were skipped (silent gap)', () => {
    // Beat 2 is missing from the timeline, exactly like N.C. beats that
    // buildChordTimeline drops. A time inside the gap must not be mapped
    // before the previous event's cell.
    const events = [event(0, 0, 0.3), event(1, 0.3, 0.6), event(3, 0.9, 1.2)];
    const mapping = createTimeToNormalizedX(events, 118, 4);
    const beforeGap = mapping(0.6);
    const midGap = mapping(0.75);
    const afterGap = mapping(0.9);
    expect(midGap).toBeGreaterThanOrEqual(beforeGap);
    expect(midGap).toBeLessThanOrEqual(afterGap + 1e-9);
  });

  it('never moves backwards when sampling through a silent gap', () => {
    const events = [event(0, 0, 0.3), event(1, 0.3, 0.6), event(3, 0.9, 1.2)];
    const mapping = createTimeToNormalizedX(events, 118, 4);
    const values = sample(mapping, 0, 1.2, 0.01);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-9);
    }
  });
});