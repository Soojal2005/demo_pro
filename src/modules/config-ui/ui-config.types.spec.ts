import { compareVersions, targetKeyFor } from './ui-config.types';

describe('UI config targeting and versions', () => {
  it('builds stable global and city target keys', () => {
    expect(targetKeyFor(null, 'all')).toBe('customer:home:global:all');
    expect(targetKeyFor('city-1', 'repeat')).toBe(
      'customer:home:city-1:repeat',
    );
  });

  it('compares semantic versions numerically rather than lexically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(() => compareVersions('v2', '1.0.0')).toThrow();
  });
});
