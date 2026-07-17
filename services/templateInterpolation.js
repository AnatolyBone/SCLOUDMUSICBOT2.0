export function interpolateTemplate(text, variables = {}, context = {}) {
  const missing = new Set();
  const rendered = String(text ?? '').replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (_match, doubleName, legacyName) => {
    const name = doubleName || legacyName;
    if (Object.prototype.hasOwnProperty.call(variables, name) && variables[name] !== undefined && variables[name] !== null) {
      return String(variables[name]);
    }
    missing.add(name);
    return '';
  });

  if (missing.size > 0) {
    const key = context.key || 'unknown';
    const lang = context.lang || 'unknown';
    console.warn(`[i18n] Missing template variables for key "${key}" (lang: ${lang}): ${[...missing].join(', ')}`);
  }

  return rendered;
}

