// quality-harness: rules live in the harness; this project's settings live in harness.config.json.
import harness from 'quality-harness/eslint';
import config from './harness.config.json' with { type: 'json' };

export default harness({ ...config, root: import.meta.dirname });
