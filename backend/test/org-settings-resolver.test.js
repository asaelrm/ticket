import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_KEYS,
  GLOBAL_KEYS,
  ORG_KEYS,
  isGlobalSetting,
  isOrgSetting,
  isKnownSetting,
  resolveSetting,
  settingDefault,
} from '../src/utils/settings.js';

describe('settings catalog and policy (ETAPA 4D-A)', () => {
  it('classifies GLOBAL_KEYS, ORG_KEYS, and unknown keys', () => {
    assert.equal(GLOBAL_KEYS.length, 2);
    assert.equal(ORG_KEYS.length, 20);
    assert.equal(ALL_KEYS.length, 22);
    assert.ok(!GLOBAL_KEYS.some((key) => ORG_KEYS.includes(key)));
    for (const key of GLOBAL_KEYS) {
      assert.equal(isGlobalSetting(key), true);
      assert.equal(isOrgSetting(key), false);
      assert.equal(isKnownSetting(key), true);
    }
    for (const key of ORG_KEYS) {
      assert.equal(isOrgSetting(key), true);
      assert.equal(isGlobalSetting(key), false);
      assert.equal(isKnownSetting(key), true);
    }
    assert.equal(isKnownSetting('no_existe'), false);
  });

  it('resolves ORG keys through tenant override, platform fallback, then default', () => {
    assert.equal(resolveSetting({ organizationId: 7, key: 'sla_high_hours', organizationValue: '9', globalValue: '6' }), '9');
    assert.equal(resolveSetting({ organizationId: 7, key: 'sla_high_hours', globalValue: '6' }), '6');
    assert.equal(resolveSetting({ organizationId: 7, key: 'sla_high_hours' }), settingDefault('sla_high_hours'));
  });

  it('makes GLOBAL keys ignore a tenant value', () => {
    assert.equal(resolveSetting({ organizationId: 7, key: 'app_name', organizationValue: 'TENANT', globalValue: 'SIFHA' }), 'SIFHA');
    assert.equal(resolveSetting({ key: 'ticket_prefix' }), settingDefault('ticket_prefix'));
  });

  it('does not enable tenant overrides for null or undefined organization context', () => {
    for (const organizationId of [null, undefined]) {
      assert.equal(
        resolveSetting({ organizationId, key: 'pending_reasons', organizationValue: '["Solo A"]' }),
        settingDefault('pending_reasons'),
      );
    }
  });

  it('returns null for an unknown key', () => {
    assert.equal(resolveSetting({ organizationId: 7, key: 'no_existe', organizationValue: 'x', globalValue: 'y' }), null);
    assert.equal(settingDefault('no_existe'), null);
  });
});
