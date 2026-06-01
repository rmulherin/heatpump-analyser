// Usage: node scripts/synthesise.mjs --archetype <path> --noise-config <path> [--output <dir>] [--verbose] [--run-tool-modules]
import { synthesise } from './lib/synthesiser.mjs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'archetype':          { type: 'string' },
    'noise-config':       { type: 'string' },
    'output':             { type: 'string' },
    'weather-cache':      { type: 'string' },
    'verbose':            { type: 'boolean', default: false },
    'run-tool-modules':   { type: 'boolean', default: false },
  },
});

if (!values.archetype || !values['noise-config']) {
  console.error('Usage: node scripts/synthesise.mjs --archetype <path> --noise-config <path> [--output <dir>] [--weather-cache <dir>] [--verbose] [--run-tool-modules]');
  process.exit(1);
}

try {
  const result = await synthesise(values.archetype, values['noise-config'], {
    outputDir:       values.output,
    weatherCacheDir: values['weather-cache'],
    verbose:         values.verbose,
    runToolModules:  values['run-tool-modules'],
  });
  console.log(`\nBake complete: ${result.slug}`);
  console.log(`  CSV:    ${result.csvPath}`);
  console.log(`  Stats:  ${result.statsPath}`);
  console.log(`  Report: ${result.reportPath}`);
  const at = result.stats.annual_totals;
  console.log(`  Gas:  ${at.gas_kwh.toFixed(0)} kWh (${at.gas_delta_pct > 0 ? '+' : ''}${at.gas_delta_pct.toFixed(1)}%)`);
  console.log(`  Elec: ${at.elec_kwh.toFixed(0)} kWh (${at.elec_delta_pct > 0 ? '+' : ''}${at.elec_delta_pct.toFixed(1)}%)`);
  if (result.stats.warnings.length > 0) {
    console.warn('\nWarnings:');
    for (const w of result.stats.warnings) console.warn(`  ⚠ ${w}`);
  }
} catch (e) {
  console.error(`Bake failed: ${e.message}`);
  process.exit(1);
}
