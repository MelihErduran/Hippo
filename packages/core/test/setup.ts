// Tests run in a fixed timezone so local-time logic is deterministic.
process.env.TZ = 'America/Los_Angeles';
process.removeAllListeners('warning');
