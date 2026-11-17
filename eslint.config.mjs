// The harness checks itself with its own rules (dogfooding). Projects import 'quality-harness/eslint'.
import harness from './config/eslint.mjs';
import config from './harness.config.json' with { type: 'json' };

export default harness({ ...config, root: import.meta.dirname });
