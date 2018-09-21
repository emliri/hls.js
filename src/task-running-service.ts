const performance = window.performance;

export class TaskRunningService {
  static POLL_MS: number = 500;

  /**
   *
   * @typedef {task: TaskLoop, lastTickAt: number} TaskLoopEntry
   * @type {[name: string]: TaskLoopEntry}
   */
  private _taskLoopRegistry = {};
  private _taskLoopRegistryId = 0;

  private _singletonInterval;
  private _singletonTimer;

  obtainTaskId (): number {
    return this._taskLoopRegistryId++;
  }

  /**
   *
   * @param {string} name
   * @param {TaskLoop} task
   */
  registerTask (name, task) {
    if (this._taskLoopRegistry[name]) {
      throw new Error('Task already registered: ' + name);
    }
    this._taskLoopRegistry[name] = {
      task,
      lastTickAt: -Infinity
    };
  }

  deregisterTask (name) {
    delete this._taskLoopRegistry[name];
  }

  // Call on destroy
  cancelTickSource () {
    clearInterval(this._singletonInterval);
    this._singletonInterval = null;
  }

  setTickSource () {
    if (this._singletonInterval) {
      return;
    }
    this._singletonInterval = setInterval(() => this._taskLoop(), TaskRunningService.POLL_MS);
  }

  // Call on destroy
  cancelTimer () {
    clearTimeout(this._singletonTimer);
    this._singletonTimer = null;
  }

  scheduleTimer (time = TaskRunningService.POLL_MS) {
    if (this._singletonTimer) {
      throw new Error('Timer already set');
    }
    this._singletonTimer = setTimeout(() => this._taskLoop(), time);
  }

  scheduleImmediateTick (name) {
    this._taskLoopRegistry[name].lastTickAt = -Infinity;
    this.cancelTimer();
    this.scheduleTimer(0);
  }

  private _taskLoop () {
    Object.getOwnPropertyNames(this._taskLoopRegistry)
      .forEach((name) => {
        const entry = this._taskLoopRegistry[name];
        const now = performance.now();
        let run = false;
        if (entry.task.hasNextTick()) {
          run = true;
        } else if (entry.task.hasInterval() &&
          now - entry.lastTickAt >= entry.task.getInterval()) {
          run = true;
        }
        if (run) {
          entry.lastTickAt = performance.now();
          entry.task.doTick();
        }
      });
  }
}
