/**
 * Edge routing — the router: orthogonal routing around every table card, with
 * parallel lines in a shared corridor nudged apart.
 *
 * Every line is routed on a sparse orthogonal grid around the padded cards
 * (A*, length + bends + crossings), may leave or enter whichever side of its
 * card is best, and is then nudged so lines that share a channel or a card
 * side read as separate wires and never cross right at a card. See
 * `orthogonal/router.ts` for the pass and `orthogonal/params.ts` for the knobs.
 */

export { createAvoidRouter, type AvoidRouter, type AvoidResult } from './orthogonal/router';
