/**
 * How much of the voice frame Hexa's hexagon section gets.
 *
 * `SET_LAYOUT_SPLIT` asks for a percentage, but what that section has to hold
 * is measured in pixels: a 44px voice pill above the face, a 44px visual-hide
 * pill below it, the gaps around both, and a face large enough to be worth
 * showing. A fixed percentage is fine while the pane is tall and fails quietly
 * when it is not. The pane is `flex: 1` in a full-height sidebar, so a
 * laptop-height window leaves it near its floor; 40% of what remains is less
 * than the two pills occupy on their own. Hexa then shrinks the face to fit
 * what is left - correctly, since the alternative is clipping both pills - and
 * a face of a few dozen pixels is a smudge its own covered-visual card cannot
 * fit a label inside.
 *
 * So the split is measured rather than assumed: ask for whatever percentage
 * puts `HEXAGON_SECTION_TARGET_PX` in the section, and settle for the API's 60%
 * ceiling when even that is not enough. Above ~630px of frame the answer is the
 * 40 this always sent, so a tall window is untouched.
 */

/** The two pills and their gaps (112px), plus a face still worth looking at. */
export const HEXAGON_SECTION_TARGET_PX = 252;

/** What tall panes have always used - and the floor, so they never shrink. */
export const HEXAGON_SPLIT_MIN_PERCENT = 40;

/** `SET_LAYOUT_SPLIT` clamps above this, so asking for more achieves nothing. */
export const HEXAGON_SPLIT_MAX_PERCENT = 60;

/**
 * @param frameHeight The iframe's *layout* height in CSS pixels, which is the
 *   viewport Hexa lays itself out in. The stylesheet may draw the frame scaled
 *   down to buy horizontal room, but a transform does not change the viewport
 *   inside it - so this is the untransformed height a `ResizeObserver` reports,
 *   not the height the frame visually occupies.
 */
export function resolveHexagonSplitPercent(frameHeight: number): number {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return HEXAGON_SPLIT_MIN_PERCENT;
  const needed = Math.ceil((HEXAGON_SECTION_TARGET_PX / frameHeight) * 100);
  if (needed < HEXAGON_SPLIT_MIN_PERCENT) return HEXAGON_SPLIT_MIN_PERCENT;
  return Math.min(HEXAGON_SPLIT_MAX_PERCENT, needed);
}
