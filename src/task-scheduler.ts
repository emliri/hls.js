import { EventHandler } from './event-handler';
import { TaskRunningService } from './task-running-service';

const POLL_MS = 500;

export abstract class TaskScheduler extends EventHandler {
  private _tickInterval: number;
  private _tickTimer: boolean;
  private _tickCallCount: number;
  private _boundTick: () => void;
  private _name: string;
  private _service: TaskRunningService;

  /**
   *
   * @param {string} name
   * @param {Hls} hls
   * @param  {...Event} events
   */
  constructor (hls, ...events) {
    super(hls, ...events);

    const id = this._service.obtainTaskId();

    this._name = String(id);
    this._tickInterval = -1;
    this._tickTimer = false;
    this._boundTick = this.tick.bind(this);

    this._service.registerTask(this._name, this);
    this._service.setTickSource();
  }

  /**
   * @override
   */
  onHandlerDestroying () {
    // clear all timers before unregistering from event bus
    this.clearNextTick();
    this.clearInterval();

    this._service.cancelTickSource();

    this._service.deregisterTask(this._name);
  }

  /**
   * @returns {boolean}
   */
  hasInterval () {
    return this._tickInterval > 0;
  }

  /**
   * @returns {boolean}
   */
  hasNextTick () {
    return this._tickTimer;
  }

  /**
   * @param {number} millis Interval time (ms)
   * @returns {boolean} True when interval has been scheduled, false when already scheduled (no effect)
   */
  setInterval (millis) {
    this._tickInterval = millis;
  }

  /**
   * @returns {number}
   */
  getInterval () {
    return this._tickInterval;
  }

  /**
   * @returns {boolean} True when interval was cleared, false when none was set (no effect)
   */
  clearInterval () {
    this._tickInterval = -1;
  }

  /**
   * @returns {boolean} True when timeout was cleared, false when none was set (no effect)
   */
  clearNextTick () {
    this._tickTimer = false;
  }

  /**
   * Will call the subclass doTick implementation in this main loop tick
   * or in the next one (via setTimeout(,0)) in case it has already been called
   * in this tick (in case this is a re-entrant call).
   */
  tick () {
    this._service.scheduleImmediateTick(this._name);
  }

  /**
   * For subclass to implement task logic
   * @abstract
   */
  doTick () {}
}
