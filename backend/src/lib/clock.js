/** Real wall-clock time. */
export class RealClock {
  now() {
    return new Date();
  }
  get speed() {
    return 1;
  }
}

/**
 * Accelerated virtual clock for the simulator: starts now and runs `speed`× faster than
 * real time, so at 10× a 15-minute candle closes every 90 seconds.
 */
export class SimClock {
  constructor(speed = 10, start = Date.now()) {
    this.speed = speed;
    this.realStart = Date.now();
    this.virtualStart = start;
  }
  now() {
    return new Date(this.virtualStart + (Date.now() - this.realStart) * this.speed);
  }
}
