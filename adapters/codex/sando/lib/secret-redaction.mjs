import { createRedactionProfile } from './redaction-profile.mjs';

const builtInProfile = createRedactionProfile();

export { createRedactionProfile };

export function redact(text) {
  return builtInProfile.redact(text);
}

export function redactStructured(value, enabled = true) {
  return enabled ? builtInProfile.redactStructured(value).value : value;
}

export function hasSecret(text) {
  return builtInProfile.hasSecret(text);
}
