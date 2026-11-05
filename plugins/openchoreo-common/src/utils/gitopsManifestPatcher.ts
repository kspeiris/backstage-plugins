import { createTwoFilesPatch } from 'diff';
import YAML from 'yaml';

const overrideFields = [
  'componentTypeEnvironmentConfigs',
  'traitEnvironmentConfigs',
  'workloadOverrides',
] as const;

type OverrideField = (typeof overrideFields)[number];
type OverrideMap = Record<string, unknown>;

export interface PatchOptions {
  componentTypeEnvironmentConfigs?: Record<string, unknown>;
  traitEnvironmentConfigs?: Record<string, unknown>;
  workloadOverrides?: Record<string, unknown>;
}

export interface PatchResult {
  originalManifest: Record<string, unknown>;
  proposedManifest: Record<string, unknown>;
  changed: boolean;
  proposedYaml: string;
}

const isRecord = (value: unknown): value is OverrideMap =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const mergeRecords = (
  current: OverrideMap,
  patch: OverrideMap,
): OverrideMap => {
  const merged: OverrideMap = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`Override contains a disallowed key: ${key}`);
    }

    const currentValue = current[key];
    Object.defineProperty(merged, key, {
      configurable: true,
      enumerable: true,
      value: isRecord(value)
        ? mergeRecords(isRecord(currentValue) ? currentValue : {}, value)
        : value,
      writable: true,
    });
  }

  return merged;
};

const canonicalize = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
      Object.defineProperty(sorted, key, {
        configurable: true,
        enumerable: true,
        value: (entry as Record<string, unknown>)[key],
        writable: true,
      });
    }
    return sorted;
  });

export function patchReleaseBindingManifest(
  yamlContent: string,
  namespace: string,
  project: string,
  component: string,
  environment: string,
  overrides: PatchOptions,
): PatchResult {
  const document = YAML.parseDocument(yamlContent);
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid ReleaseBinding YAML: ${document.errors
        .map(error => error.message)
        .join('; ')}`,
    );
  }

  const manifest = document.toJS() as Record<string, unknown> | null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('ReleaseBinding manifest is not a YAML object');
  }

  const metadata = manifest.metadata as Record<string, unknown> | undefined;
  const spec = manifest.spec as Record<string, unknown> | undefined;
  const owner = spec?.owner as Record<string, unknown> | undefined;
  if (
    manifest.apiVersion !== 'openchoreo.dev/v1alpha1' ||
    manifest.kind !== 'ReleaseBinding' ||
    metadata?.name !== `${component}-${environment}` ||
    metadata.namespace !== namespace ||
    owner?.projectName !== project ||
    owner.componentName !== component ||
    spec?.environment !== environment ||
    typeof spec.releaseName !== 'string' ||
    !spec.releaseName
  ) {
    throw new Error(
      `ReleaseBinding manifest identity does not match ${namespace}/${project}/${component}/${environment}`,
    );
  }

  const originalManifest = structuredClone(manifest);
  const patches: Partial<Record<OverrideField, OverrideMap>> = {};
  for (const field of overrideFields) {
    const value = overrides[field];
    if (value !== undefined) {
      if (!isRecord(value)) {
        throw new Error(`${field} must be an object`);
      }
      patches[field] = value;
    }
  }
  if (Object.keys(patches).length === 0) {
    throw new Error('At least one override section must be provided');
  }

  for (const field of overrideFields) {
    const patch = patches[field];
    if (!patch) {
      continue;
    }

    const currentValue = spec[field];
    if (currentValue !== undefined && !isRecord(currentValue)) {
      throw new Error(`Existing ${field} in manifest must be a YAML object`);
    }

    document.setIn(
      ['spec', field],
      mergeRecords((currentValue as OverrideMap | undefined) ?? {}, patch),
    );
  }

  const proposedYaml = document.toString();
  const proposedManifest = document.toJS() as Record<string, unknown>;
  return {
    originalManifest,
    proposedManifest,
    changed: canonicalize(originalManifest) !== canonicalize(proposedManifest),
    proposedYaml,
  };
}

export function generateUnifiedDiff(
  original: string,
  proposed: string,
  filename = 'release-binding.yaml',
): string {
  return createTwoFilesPatch(
    `a/${filename}`,
    `b/${filename}`,
    original,
    proposed,
    'original',
    'proposed',
    { context: 3 },
  );
}
