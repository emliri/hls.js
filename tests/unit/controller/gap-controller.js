import sinon from 'sinon';

import Hls from '../../../src/hls';

import GapController from '../../../src/controller/gap-controller'; // eslint-disable-line import/no-duplicates
import { STALL_DEBOUNCE_INTERVAL_MS } from '../../../src/controller/gap-controller'; // eslint-disable-line import/no-duplicates
import { FragmentTracker } from '../../../src/controller/fragment-tracker';

import Event from '../../../src/events';

import { ErrorTypes, ErrorDetails } from '../../../src/errors';

describe('checkBuffer', function () {
  let gapController;
  let config;
  let media;
  let triggerSpy;
  const sandbox = sinon.createSandbox();

  beforeEach(function () {
    const hls = new Hls({});
    media = document.createElement('video');
    config = hls.config;
    gapController = new GapController(config, media, new FragmentTracker(hls), hls);
    triggerSpy = sinon.spy(hls, 'trigger');
  });

  afterEach(function () {
    sandbox.restore();
  });

  describe('_tryNudgeBuffer', function () {
    it('should increment the currentTime by a multiple of nudgeRetry and the configured nudge amount', function () {
      for (let i = 1; i < config.nudgeMaxRetry; i++) {
        let expected = media.currentTime + (i * config.nudgeOffset);
        gapController._tryNudgeBuffer();
        expect(media.currentTime).to.equal(expected);
      }

      expect(triggerSpy).to.have.been.calledWith(Event.ERROR, {
        type: ErrorTypes.MEDIA_ERROR,
        details: ErrorDetails.BUFFER_NUDGE_ON_STALL,
        fatal: false
      });
    });

    it('should not increment the currentTime if the max amount of nudges has been attempted', function () {
      config.nudgeMaxRetry = 0;
      gapController._tryNudgeBuffer();
      expect(media.currentTime).to.equal(0);
      expect(triggerSpy).to.have.been.calledWith(Event.ERROR, {
        type: ErrorTypes.MEDIA_ERROR,
        details: ErrorDetails.BUFFER_STALLED_ERROR,
        fatal: true
      });
    });
  });

  describe('_reportStall', function () {
    it('should report a stall with the current buffer length if it has not already been reported', function () {
      gapController._reportStall(42);
      expect(triggerSpy).to.have.been.calledWith(Event.ERROR, {
        type: ErrorTypes.MEDIA_ERROR,
        details: ErrorDetails.BUFFER_STALLED_ERROR,
        fatal: false,
        buffer: 42
      });
    });

    it('should not report a stall if it was already reported', function () {
      gapController.stallReported = true;
      gapController._reportStall(42);
      expect(triggerSpy).to.not.have.been.called;
    });
  });

  describe('_tryFixBufferStall', function () {
    it('should nudge when stalling close to the buffer end', function () {
      const mockBufferInfo = { len: 1 };
      const mockStallDuration = (config.highBufferWatchdogPeriod + 1) * 1000;
      const nudgeStub = sandbox.stub(gapController, '_tryNudgeBuffer');
      gapController._tryFixBufferStall(mockBufferInfo, mockStallDuration);
      expect(nudgeStub).to.have.been.calledOnce;
    });

    it('should not nudge when briefly stalling close to the buffer end', function () {
      const mockBufferInfo = { len: 1 };
      const mockStallDuration = (config.highBufferWatchdogPeriod / 2) * 1000;
      const nudgeStub = sandbox.stub(gapController, '_tryNudgeBuffer');
      gapController._tryFixBufferStall(mockBufferInfo, mockStallDuration);
      expect(nudgeStub).to.have.not.been.called;
    });

    it('should not nudge when too far from the buffer end', function () {
      const mockBufferInfo = { len: 0.25 };
      const mockStallDuration = (config.highBufferWatchdogPeriod + 1) * 1000;
      const nudgeStub = sandbox.stub(gapController, '_tryNudgeBuffer');
      gapController._tryFixBufferStall(mockBufferInfo, mockStallDuration);
      expect(nudgeStub).to.have.not.been.called;
    });

    it('should try to jump partial fragments when detected', function () {
      sandbox.stub(gapController.fragmentTracker, 'getPartialFragment').returns({});
      const skipHoleStub = sandbox.stub(gapController, '_trySkipBufferHole');
      gapController._tryFixBufferStall({ len: 0 });
      expect(skipHoleStub).to.have.been.calledOnce;
    });

    it('should not try to jump partial fragments when none are detected', function () {
      sandbox.stub(gapController.fragmentTracker, 'getPartialFragment').returns(null);
      const skipHoleStub = sandbox.stub(gapController, '_trySkipBufferHole');
      gapController._tryFixBufferStall({ len: 0 });
      expect(skipHoleStub).to.have.not.been.called;
    });
  });

  describe('poll', function () {
    let mockMedia;
    let mockTimeRanges;
    let mockTimeRangesData;
    let reportStallSpy;
    let lastCurrentTime;

    beforeEach(function () {
      mockTimeRangesData = [[100, 200], [400, 500]];
      mockTimeRanges = {
        length: mockTimeRangesData.length,
        start (index) {
          return mockTimeRangesData[index][0];
        },
        end (index) {
          return mockTimeRangesData[index][1];
        }
      };

      mockMedia = {
        currentTime: 0,
        paused: false,
        readyState: 0,
        buffered: mockTimeRanges,
        addEventListener () {}
      };

      gapController.media = mockMedia;
      reportStallSpy = sandbox.spy(gapController, '_reportStall');
    });

    function setStalling () {
      mockMedia.paused = false;
      mockMedia.readyState = 4;
      mockMedia.currentTime = 4;
      lastCurrentTime = 4;
    }

    function setNotStalling () {
      mockMedia.paused = false;
      mockMedia.readyState = 4;
      mockMedia.currentTime = 5;
      lastCurrentTime = 4;
    }

    it('should try to fix a stall if expected to be playing', function () {
      const clock = sandbox.useFakeTimers(0);

      const fixStallStub = sandbox.stub(gapController, '_tryFixBufferStall');
      setStalling();

      clock.tick(1);

      gapController.poll(lastCurrentTime);

      clock.tick(1);

      // The first poll call made while stalling just sets stall flags
      expect(typeof gapController.stallDetectedAtTime).to.equal('number');
      expect(typeof gapController.stallHandledAtTime).to.equal('number');
      expect(gapController.stallReported).to.equal(false);

      clock.tick(STALL_DEBOUNCE_INTERVAL_MS);

      gapController.poll(lastCurrentTime);

      expect(fixStallStub).to.have.been.calledOnce;
    });

    it('should reset stall flags when no longer stalling', function () {
      setNotStalling();
      gapController.stallReported = true;
      gapController.nudgeRetry = 1;
      gapController.stallDetectedAtTime = 4200;
      gapController.stallHandledAtTime = 4201;

      const fixStallStub = sandbox.stub(gapController, '_tryFixBufferStall');

      gapController.poll(lastCurrentTime);

      expect(gapController.stallDetectedAtTime).to.equal(null);
      expect(gapController.stallHandledAtTime).to.equal(null);
      expect(gapController.nudgeRetry).to.equal(0);
      expect(gapController.stallReported).to.equal(false);

      expect(fixStallStub).to.have.not.been.called;
    });

    it('should trigger reportStall when stalling for 1 second or longer', function () {
      setStalling();
      const clock = sandbox.useFakeTimers(0);
      clock.tick(1000);
      gapController.stallDetectedAtTime = 1;
      gapController.poll(lastCurrentTime);

      expect(reportStallSpy).to.have.not.been.called;

      clock.tick(1001);
      gapController.poll(lastCurrentTime);

      expect(reportStallSpy).to.have.been.calledOnce;
    });
  });
});
