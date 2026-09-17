import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEXAGON_SPLIT_MAX_PERCENT,
  HEXAGON_SPLIT_MIN_PERCENT,
  resolveHexagonSplitPercent,
} from '@/lib/hexa-layout-split';

/**
 * The height half of Hexa's own fit calculation: its compact ceiling against
 * the section minus the 112px the two pills and their gaps cost. The sidebar is
 * never the narrower bound, so the width term is left out.
 */
const faceSizeFor = (frameHeight: number, splitPercent: number) =>
  Math.min(240, Math.floor((frameHeight * splitPercent) / 100) - 112);

test('a tall pane keeps the split it has always been sent', () => {
  // The desktop case: a 44rem pane scaled to a ~927px frame. 40% of that is far
  // more than the section needs, so nothing about a big window changes.
  assert.equal(resolveHexagonSplitPercent(927), HEXAGON_SPLIT_MIN_PERCENT);
  assert.equal(resolveHexagonSplitPercent(630), HEXAGON_SPLIT_MIN_PERCENT);
});

test('a short pane asks for the share the two pills and the face actually need', () => {
  // Just under the point where 40% stops covering the section.
  assert.equal(resolveHexagonSplitPercent(600), 42);
  assert.equal(resolveHexagonSplitPercent(500), 51);
});

test('the request stops at the ceiling SET_LAYOUT_SPLIT would clamp to anyway', () => {
  // The laptop case: a ~329px pane leaves a ~391px frame once the header and
  // the 0.7 scale are accounted for. The section wants 65% and gets 60.
  assert.equal(resolveHexagonSplitPercent(391), HEXAGON_SPLIT_MAX_PERCENT);
  assert.equal(resolveHexagonSplitPercent(120), HEXAGON_SPLIT_MAX_PERCENT);
});

test('the ceiling still leaves a face large enough to hold its own label', () => {
  // The failure this exists to stop: at a flat 40% the short frame gives Hexa
  // 45px of face, and the covered-visual card cannot fit "Visual hidden" in it.
  assert.equal(faceSizeFor(391, HEXAGON_SPLIT_MIN_PERCENT), 44);
  assert.ok(faceSizeFor(391, resolveHexagonSplitPercent(391)) >= 120);
});

test('a frame with no measurable height falls back to the resting split', () => {
  // The first observation can land before layout, and a collapsed sidebar
  // unmounts the pane entirely. Neither should push the split around.
  for (const height of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveHexagonSplitPercent(height), HEXAGON_SPLIT_MIN_PERCENT);
  }
});
