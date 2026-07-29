// Tiny shared assertion helper for the unit suites.
export function makeChecker() {
  let failures = 0;
  const check = (name: string, cond: boolean, extra = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? `  — ${extra}` : ''}`);
    if (!cond) failures++;
  };
  const done = (label: string) => {
    console.log(`${failures ? `${failures} check(s) FAILED` : 'all checks passed'} — ${label}`);
    if (failures) process.exit(1);
  };
  return { check, done };
}
