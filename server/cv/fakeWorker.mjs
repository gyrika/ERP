// A stand-in for server/cv/worker.ts in server/cvWorker.test.ts: no camera, ffmpeg or ONNX.
// Says ready, echoes each config as a log line, one event and a heartbeat, answers a watch with one
// detection, and exits with code 3 when FAKE_WORKER_CRASH is set (so the server's restart and backoff can be tested).
process.on('message', (m) => {
  if (m.type === 'stop') process.exit(0);
  if (m.type === 'watch') {
    if (m.cameraId) process.send({ type: 'seen', cameraId: m.cameraId, at: 2000, detectedAt: 1000, persons: [{ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.9, score: 0.87 }] });
    else process.send({ type: 'log', text: 'unwatched' });
  }
  if (m.type === 'config') {
    process.send({ type: 'log', text: `config ${m.config.mode} ${m.config.cameras.length}` });
    process.send({ type: 'event', at: 1000, fields: { type: 'vision.camera_online', cameraId: m.config.cameras[0].id } });
    process.send({ type: 'heartbeat', at: 1000, cameras: [{ id: m.config.cameras[0].id, online: true, fps: 1 }], cpu: 3, slowed: false });
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready' });
if (process.env.FAKE_WORKER_CRASH) setTimeout(() => process.exit(3), 30);
