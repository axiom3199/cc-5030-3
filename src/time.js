'use strict';

// Media time is stored EXACTLY as integer ticks on a fixed master timebase.
// 30000 ticks/sec divides 24/25/30/60 fps frame durations exactly, so no
// floating point ever participates in boundary math or conflict checks.
const TICKS_PER_SECOND = 30000;

const isInt = (v) => Number.isInteger(v);

function ticksToRational(t) {
  if (!isInt(t) || t < 0) throw new Error(`bad tick value: ${t}`);
  return { n: t, d: TICKS_PER_SECOND };
}

// "12000/30000" style rational or integer seconds -> ticks, exact.
function rationalToTicks(r) {
  if (typeof r === 'number') {
    if (!isInt(r)) throw new Error('non-integer seconds are not exact; use {n,d}');
    return r * TICKS_PER_SECOND;
  }
  if (!r || !isInt(r.n) || !isInt(r.d) || r.d <= 0) {
    throw new Error('rational must be {n:int,d:positive int}');
  }
  const v = r.n * TICKS_PER_SECOND;
  if (v % r.d !== 0) {
    throw new Error(`rational ${r.n}/${r.d} is not representable on the ${TICKS_PER_SECOND}Hz timebase`);
  }
  return v / r.d;
}

function ticksToSecondsExact(t) {
  return { n: t, d: TICKS_PER_SECOND };
}

function ticksToDecimal(t) {
  // display only, never used for decisions
  return t / TICKS_PER_SECOND;
}

// For a source with a given fps, return the exact frame index covering a tick.
function tickToFrameIndex(t, fpsNum, fpsDen) {
  const frameDur = (TICKS_PER_SECOND * fpsDen) / fpsNum;
  if (!isInt(frameDur)) throw new Error('fps not supported by master timebase');
  return Math.floor(t / frameDur);
}

function frameIndexToTick(frameIndex, fpsNum, fpsDen) {
  return Math.floor((TICKS_PER_SECOND * fpsDen * frameIndex) / fpsNum);
}

module.exports = {
  TICKS_PER_SECOND,
  ticksToRational,
  rationalToTicks,
  ticksToSecondsExact,
  ticksToDecimal,
  tickToFrameIndex,
  frameIndexToTick,
};
