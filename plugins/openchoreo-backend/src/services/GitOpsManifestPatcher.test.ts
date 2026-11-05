import {
  patchReleaseBindingManifest,
  generateUnifiedDiff,
} from '@openchoreo/backstage-plugin-common';

describe('GitOpsManifestPatcher', () => {
  const validManifestYaml = `apiVersion: openchoreo.dev/v1alpha1
kind: ReleaseBinding
metadata:
  name: biocare-web-staging
  namespace: default
spec:
  owner:
    projectName: default
    componentName: biocare-web
  environment: staging
  releaseName: v1.0.0
  componentTypeEnvironmentConfigs:
    replicas: 1
  traitEnvironmentConfigs: {}
  workloadOverrides:
    container:
      env:
        - key: FOO
          value: bar
`;

  describe('patchReleaseBindingManifest', () => {
    it('should patch workload overrides successfully', () => {
      const result = patchReleaseBindingManifest(
        validManifestYaml,
        'default',
        'default',
        'biocare-web',
        'staging',
        {
          workloadOverrides: {
            container: {
              env: [{ key: 'NEW_VAR', value: 'new_value' }],
            },
          },
        },
      );

      expect(result.changed).toBe(true);
      expect(result.originalManifest).toBeDefined();
      expect(result.proposedManifest).toBeDefined();
      expect(result.proposedYaml).toContain('NEW_VAR');
    });

    it('should throw on invalid YAML', () => {
      expect(() =>
        patchReleaseBindingManifest(
          'invalid: yaml: content:',
          'default',
          'default',
          'biocare-web',
          'staging',
          { workloadOverrides: {} },
        ),
      ).toThrow('Invalid ReleaseBinding YAML');
    });

    it('should throw on identity mismatch', () => {
      expect(() =>
        patchReleaseBindingManifest(
          validManifestYaml,
          'wrong-namespace',
          'default',
          'biocare-web',
          'staging',
          { workloadOverrides: {} },
        ),
      ).toThrow('identity does not match');
    });

    it('should throw when no overrides provided', () => {
      expect(() =>
        patchReleaseBindingManifest(
          validManifestYaml,
          'default',
          'default',
          'biocare-web',
          'staging',
          {},
        ),
      ).toThrow('At least one override section must be provided');
    });

    it('should throw on disallowed keys in override', () => {
      const workloadOverrides: Record<string, unknown> = JSON.parse(
        '{"__proto__":{"polluted":true}}',
      );
      expect(() =>
        patchReleaseBindingManifest(
          validManifestYaml,
          'default',
          'default',
          'biocare-web',
          'staging',
          { workloadOverrides },
        ),
      ).toThrow('disallowed key');
    });

    it('should detect no change when patching with same values', () => {
      const result = patchReleaseBindingManifest(
        validManifestYaml,
        'default',
        'default',
        'biocare-web',
        'staging',
        {
          workloadOverrides: {
            container: {
              env: [{ key: 'FOO', value: 'bar' }],
            },
          },
        },
      );

      expect(result.changed).toBe(false);
    });

    it('should merge trait configs correctly', () => {
      const result = patchReleaseBindingManifest(
        validManifestYaml,
        'default',
        'default',
        'biocare-web',
        'staging',
        {
          traitEnvironmentConfigs: {
            'my-trait': { enabled: true },
          },
        },
      );

      expect(result.changed).toBe(true);
      expect(result.proposedYaml).toContain('my-trait');
    });

    it('should merge component type configs correctly', () => {
      const result = patchReleaseBindingManifest(
        validManifestYaml,
        'default',
        'default',
        'biocare-web',
        'staging',
        {
          componentTypeEnvironmentConfigs: {
            replicas: 5,
          },
        },
      );

      expect(result.changed).toBe(true);
      expect(result.proposedYaml).toContain('replicas: 5');
    });
  });

  describe('generateUnifiedDiff', () => {
    it('should generate a diff with added lines', () => {
      const original = 'line1\nline2\nline3';
      const proposed = 'line1\nline2\nline3\nline4';
      const diff = generateUnifiedDiff(original, proposed);

      expect(diff).toContain('---');
      expect(diff).toContain('+++');
      expect(diff).toContain('+line4');
    });

    it('should generate a diff with removed lines', () => {
      const original = 'line1\nline2\nline3';
      const proposed = 'line1\nline3';
      const diff = generateUnifiedDiff(original, proposed);

      expect(diff).toContain('-line2');
    });

    it('should show context lines', () => {
      const original = 'line1\nline2\nline3';
      const proposed = 'line1\nline2 changed\nline3';
      const diff = generateUnifiedDiff(original, proposed);

      expect(diff).toContain(' line1');
      expect(diff).toContain('-line2');
      expect(diff).toContain('+line2 changed');
      expect(diff).toContain(' line3');
    });
  });
});
