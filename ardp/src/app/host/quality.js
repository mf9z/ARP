'use strict';

// bits per pixel per frame. 1080p60 lands near 4, 11 and 27 mbit/s
const QUALITY = {
  low: { bpp: 0.035, fps: 30 },
  balanced: { bpp: 0.09, fps: 60 },
  high: { bpp: 0.22, fps: 60 },
};

function plan(quality, width, height, fpsCap = 60) {
  const q = QUALITY[quality] || QUALITY.balanced;
  const max = Math.round(Math.min(80e6, Math.max(1.5e6, width * height * 60 * q.bpp)));
  return { fps: Math.min(q.fps, fpsCap), bitrate: { start: max, min: Math.min(500_000, max), max } };
}

module.exports = { plan };
