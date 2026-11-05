import { useState, useMemo, useEffect, useRef } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Tooltip,
  Typography,
} from '@material-ui/core';
import CompareArrowsIcon from '@material-ui/icons/CompareArrows';
import { Alert } from '@material-ui/lab';
import { Entity } from '@backstage/catalog-model';
import { useApi } from '@backstage/core-plugin-api';
import { openChoreoClientApiRef } from '../../api/OpenChoreoClientApi';
import { makeStyles } from '@material-ui/core/styles';
import { getErrorMessage } from '../../utils/errorUtils';
import { OverrideContent } from './OverrideContent';
import { useOverrideChanges } from './hooks/useOverrideChanges';
import { useOverridesData } from './hooks/useOverridesData';
import { ComponentReleaseDiffDialog } from './components/ComponentReleaseDiffDialog';
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog';
import {
  UnsavedChangesDialog,
  useUrlSyncedTab,
  DetailPageLayout,
} from '@openchoreo/backstage-plugin-react';
import {
  calculateHasOverrides,
  getMissingRequiredFields,
} from './overridesUtils';
import type { Environment } from './hooks/useEnvironmentData';
import type { PendingAction } from './types';
import {
  VerticalTabNav,
  TabItemData,
} from '@openchoreo/backstage-design-system';
import MemoryIcon from '@material-ui/icons/Memory';
import SettingsIcon from '@material-ui/icons/Settings';
import ExtensionIcon from '@material-ui/icons/Extension';
import { ContainerContent } from './Workload/WorkloadEditor';
import {
  useSecretReferences,
  filterSecretReferencesForEnvDataPlane,
} from '@openchoreo/backstage-plugin-react';
import type { EnvVar } from '@openchoreo/backstage-plugin-common';
import { TraitParameters } from './TraitParameters';
import {
  GitOpsOverridePreview,
  GitOpsOverridePullRequestResponse,
} from '../../api/OpenChoreoClientApi';
import { YamlDiffViewer } from '@openchoreo/backstage-plugin-react';
import LaunchIcon from '@material-ui/icons/Launch';

const useStyles = makeStyles(theme => ({
  loadingContainer: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '300px',
  },
  errorContainer: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '300px',
    gap: theme.spacing(2),
  },
  helpText: {
    padding: theme.spacing(2),
    backgroundColor: theme.palette.background.default,
    borderRadius: theme.shape.borderRadius,
    marginBottom: theme.spacing(2),
  },
  tabNav: {
    height: '100%',
    minHeight: 400,
  },
}));

interface EnvironmentOverridesPageProps {
  environment: Environment;
  entity: Entity;
  onBack: () => void;
  onSaved?: () => void;
  /** Pending action to execute after saving overrides */
  pendingAction?: PendingAction;
  /** Callback when overrides are saved and pending action should be executed */
  onPendingActionComplete?: (action: PendingAction) => Promise<void>;
  /** Callback when Previous button is clicked (only shown when pendingAction exists) */
  onPrevious?: () => void;
  /** Initial tab to display (from URL) */
  initialTab?: string;
  /** Callback when tab changes (to update URL). Second param is replace (default false). */
  onTabChange?: (tabId: string, replace?: boolean) => void;
}

export const EnvironmentOverridesPage = ({
  environment,
  entity,
  onBack,
  onSaved: _onSaved,
  pendingAction,
  onPendingActionComplete: _onPendingActionComplete,
  onPrevious,
  initialTab,
  onTabChange,
}: EnvironmentOverridesPageProps) => {
  const classes = useStyles();
  const client = useApi(openChoreoClientApiRef);

  const [traitTypeMap, setTraitTypeMap] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<
    'all' | 'component' | string | null
  >(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] =
    useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  // GitOps preview state
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] =
    useState<GitOpsOverridePreview | null>(null);

  // Snapshot of form values at the time the last preview was generated.
  // If the current form values diverge from this snapshot the preview is stale.
  const previewSnapshot = useRef<{
    componentTypeFormData: any;
    traitFormDataMap: any;
    workloadFormData: any;
  } | null>(null);
  const [previewIsStale, setPreviewIsStale] = useState(false);

  // Pull request creation state
  const [prLoading, setPrLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [prResult, setPrResult] =
    useState<GitOpsOverridePullRequestResponse | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  // True while an env var or file mount row is in edit mode in the
  // Workload tab. Blocks the primary action so users can't submit a
  // half-typed row with empty key/value.
  const [isWorkloadRowEditing, setIsWorkloadRowEditing] = useState(false);



  // Load secret references for workload overrides — limited to refs whose
  // value is reachable from this environment's data plane (or unscoped refs).
  const { secretReferences: allSecretReferences } = useSecretReferences();
  const secretReferences = useMemo(
    () =>
      filterSecretReferencesForEnvDataPlane(allSecretReferences, {
        kind: environment.dataPlaneKind,
        name: environment.dataPlaneRef,
      }),
    [allSecretReferences, environment.dataPlaneKind, environment.dataPlaneRef],
  );

  // Fetch component traits to get trait type information
  useEffect(() => {
    const fetchTraitTypes = async () => {
      try {
        const traits = await client.fetchComponentTraits(entity);
        const typeMap: Record<string, string> = {};
        traits.forEach(trait => {
          typeMap[trait.instanceName] = trait.name;
        });
        setTraitTypeMap(typeMap);
      } catch (err) {
        // Silently fail - trait types are nice to have but not critical
      }
    };
    fetchTraitTypes();
  }, [client, entity]);

  // Use pendingAction release name when promoting/deploying, otherwise use environment's release
  const releaseNameForOverrides =
    pendingAction?.releaseName || environment.deployment.releaseName;

  // Use K8s resource name for API calls (matches binding.environment from backend)
  const environmentName = environment.resourceName || environment.name;

  // Load data using custom hook
  const {
    loading,
    error: loadError,
    schemas,
    formState,
    setComponentTypeFormData,
    setTraitFormDataMap,
    setWorkloadFormData,
    reload,
  } = useOverridesData(
    entity,
    environmentName,
    releaseNameForOverrides,
    true, // always open
  );

  // Calculate changes
  const changes = useOverrideChanges(
    formState.initialComponentTypeFormData,
    formState.componentTypeFormData,
    formState.initialTraitFormDataMap,
    formState.traitFormDataMap,
    formState.initialWorkloadFormData,
    formState.workloadFormData,
  );

  // Calculate override states
  const currentOverrides = calculateHasOverrides(
    formState.componentTypeFormData,
    formState.traitFormDataMap,
    formState.workloadFormData,
  );
  const initialOverrides = calculateHasOverrides(
    formState.initialComponentTypeFormData,
    formState.initialTraitFormDataMap,
    formState.initialWorkloadFormData,
  );

  // Calculate missing required fields for validation
  const missingRequiredFields = useMemo(() => {
    if (!schemas.componentTypeSchema) {
      return [];
    }
    return getMissingRequiredFields(
      schemas.componentTypeSchema,
      formState.componentTypeFormData,
    );
  }, [schemas.componentTypeSchema, formState.componentTypeFormData]);

  // Invalidate preview whenever the developer changes form values after generating a preview
  useEffect(() => {
    if (!previewSnapshot.current || !previewResult) return;
    const snap = previewSnapshot.current;
    const stale =
      JSON.stringify(snap.componentTypeFormData) !==
        JSON.stringify(formState.componentTypeFormData) ||
      JSON.stringify(snap.traitFormDataMap) !==
        JSON.stringify(formState.traitFormDataMap) ||
      JSON.stringify(snap.workloadFormData) !==
        JSON.stringify(formState.workloadFormData);
    if (stale) {
      setPreviewIsStale(true);
      setPrResult(null);
      setPrError(null);
      // Generate new idempotency key for new logical operation
      setIdempotencyKey(
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
    }
  }, [
    formState.componentTypeFormData,
    formState.traitFormDataMap,
    formState.workloadFormData,
    previewResult,
  ]);

  // Helper function to determine tab status with priority: error > info > success > undefined
  const getTabStatus = (
    hasInitialData: boolean,
    hasChanges: boolean,
    hasMissingRequired: boolean,
  ): TabItemData['status'] => {
    if (hasMissingRequired) return 'error';
    if (hasChanges) return 'info';
    if (hasInitialData) return 'success';
    return undefined;
  };

  // Build tabs from available schemas
  const tabs = useMemo<TabItemData[]>(() => {
    const tabList: TabItemData[] = [];

    // Add Workload tab first (matches Configure Component order)
    // Use hasActualWorkloadOverrides to check if backend has real overrides
    const hasInitialWorkloadData = formState.hasActualWorkloadOverrides;
    const hasWorkloadChanges = (changes.workload?.length || 0) > 0;
    // Workload doesn't use JSON schema, so no required field validation
    tabList.push({
      id: 'workload',
      label: 'Workload',
      icon: <SettingsIcon />,
      status: getTabStatus(hasInitialWorkloadData, hasWorkloadChanges, false),
    });

    // Add Component Overrides tab if schema exists
    if (schemas.componentTypeSchema) {
      // Use hasActualComponentOverrides to check if backend has real overrides (not just defaults)
      const hasInitialComponentData = formState.hasActualComponentOverrides;
      const hasComponentChanges = changes.component.length > 0;
      const hasMissingComponentRequired = missingRequiredFields.length > 0;

      tabList.push({
        id: 'component',
        label: 'Component',
        icon: <MemoryIcon />,
        status: getTabStatus(
          hasInitialComponentData,
          hasComponentChanges,
          hasMissingComponentRequired,
        ),
      });
    }

    // Build trait child tabs
    const traitTabs: TabItemData[] = [];
    Object.keys(schemas.traitSchemasMap).forEach(traitName => {
      const traitSchema = schemas.traitSchemasMap[traitName];
      // Use hasActualTraitEnvironmentConfigsMap to check if backend has real overrides for this trait
      const hasInitialTraitData =
        formState.hasActualTraitEnvironmentConfigsMap[traitName] || false;
      const hasTraitChanges = (changes.traits[traitName]?.length || 0) > 0;
      const traitMissingRequired = getMissingRequiredFields(
        traitSchema,
        formState.traitFormDataMap[traitName],
      );

      traitTabs.push({
        id: `trait-${traitName}`,
        label: traitName,
        // icon: <ExtensionIcon />,
        status: getTabStatus(
          hasInitialTraitData,
          hasTraitChanges,
          traitMissingRequired.length > 0,
        ),
      });
    });

    // Add Traits group if there are any trait tabs
    if (traitTabs.length > 0) {
      // Aggregate status from child traits - prioritize error > info > success
      let aggregatedStatus: TabItemData['status'] = undefined;
      if (traitTabs.some(t => t.status === 'error')) {
        aggregatedStatus = 'error';
      } else if (traitTabs.some(t => t.status === 'info')) {
        aggregatedStatus = 'info';
      } else if (traitTabs.some(t => t.status === 'success')) {
        aggregatedStatus = 'success';
      }

      tabList.push({
        id: 'traits-group',
        label: 'Traits',
        icon: <ExtensionIcon />,
        isGroup: true,
        children: traitTabs,
        status: aggregatedStatus,
      });
    }

    return tabList;
  }, [
    schemas,
    formState.hasActualComponentOverrides,
    formState.hasActualTraitEnvironmentConfigsMap,
    formState.hasActualWorkloadOverrides,
    formState.traitFormDataMap,
    changes,
    missingRequiredFields,
  ]);

  // Tab state with URL sync
  const [activeTab, setActiveTab] = useUrlSyncedTab({
    initialTab,
    defaultTab: '',
    onTabChange,
  });

  // Set default active tab when tabs are loaded
  useEffect(() => {
    // baseWorkloadData is only set after initial load completes (null until then)
    if (
      !loading &&
      formState.baseWorkloadData &&
      tabs.length > 0 &&
      !activeTab
    ) {
      const defaultTab = tabs[0].id;
      // Use replace: true to avoid adding to history when auto-setting default tab
      setActiveTab(defaultTab, true);
    }
  }, [loading, formState.baseWorkloadData, tabs, activeTab, setActiveTab]);

  // Workload container management functions.
  const handleContainerChange = (field: string, value: any) => {
    setWorkloadFormData((prev: any) => ({
      ...prev,
      container: { ...(prev.container || {}), [field]: value },
    }));
  };

  const handleEnvVarChange = (
    envIndex: number,
    field: string,
    value: string,
  ) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const env = [...(container.env || [])];
      env[envIndex] = { ...env[envIndex], [field]: value };
      return { ...prev, container: { ...container, env } };
    });
  };

  const handleEnvVarReplace = (envIndex: number, envVar: EnvVar) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const env = [...(container.env || [])];
      env[envIndex] = envVar;
      return { ...prev, container: { ...container, env } };
    });
  };

  const handleFileVarChange = (
    fileIndex: number,
    field: string,
    value: string,
  ) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const files = [...((container.files as any[]) || [])];
      files[fileIndex] = { ...files[fileIndex], [field]: value };
      return { ...prev, container: { ...container, files } };
    });
  };

  const handleAddEnvVar = () => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      return {
        ...prev,
        container: {
          ...container,
          env: [...(container.env || []), { key: '', value: '' }],
        },
      };
    });
  };

  const handleRemoveEnvVar = (envIndex: number) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const env = (container.env || []).filter(
        (_: any, index: number) => index !== envIndex,
      );
      return { ...prev, container: { ...container, env } };
    });
  };

  const handleAddFileVar = () => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      return {
        ...prev,
        container: {
          ...container,
          files: [
            ...((container.files as any[]) || []),
            { key: '', mountPath: '', value: '' },
          ],
        },
      };
    });
  };

  const handleRemoveFileVar = (fileIndex: number) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const files = ((container.files as any[]) || []).filter(
        (_: any, index: number) => index !== fileIndex,
      );
      return { ...prev, container: { ...container, files } };
    });
  };

  const handleArrayFieldChange = (field: string, value: string) => {
    const arrayValue = value
      .split(',')
      .map((item: string) => item.trim())
      .filter((item: string) => item);
    setWorkloadFormData((prev: any) => ({
      ...prev,
      container: { ...(prev.container || {}), [field]: arrayValue },
    }));
  };

  // Handle starting override of an inherited env var
  const handleStartOverride = (envVar: EnvVar) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const existingEnv: EnvVar[] = container.env || [];
      if (existingEnv.some((e: EnvVar) => e.key === envVar.key)) return prev;
      return {
        ...prev,
        container: { ...container, env: [...existingEnv, { ...envVar }] },
      };
    });
  };

  // Handle starting override of an inherited file var
  const handleStartFileOverride = (
    fileVar: import('@openchoreo/backstage-plugin-common').FileVar,
  ) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const existingFiles: any[] = (container.files as any[]) || [];
      if (
        existingFiles.some(
          (f: import('@openchoreo/backstage-plugin-common').FileVar) =>
            f.key === fileVar.key,
        )
      ) {
        return prev;
      }
      return {
        ...prev,
        container: { ...container, files: [...existingFiles, { ...fileVar }] },
      };
    });
  };

  // Handle replacing an entire file var at once (atomic update)
  const handleFileVarReplace = (
    fileIndex: number,
    fileVar: import('@openchoreo/backstage-plugin-common').FileVar,
  ) => {
    setWorkloadFormData((prev: any) => {
      const container = prev.container || {};
      const files = [...((container.files as any[]) || [])];
      files[fileIndex] = fileVar;
      return { ...prev, container: { ...container, files } };
    });
  };

  // Calculate if there are any changes
  const totalChanges =
    changes.component.length +
    Object.values(changes.traits).reduce(
      (sum, traitChanges) => sum + traitChanges.length,
      0,
    ) +
    (changes.workload?.length || 0);

  // GitOps-only preview: call the backend preview API, capture snapshot for staleness detection
  const handlePreviewClick = async () => {
    if (totalChanges === 0) {
      setPreviewError('There are no override changes to preview.');
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewIsStale(false);
    setPrResult(null);
    setPrError(null);
    // Generate new idempotency key for a new logical operation
    setIdempotencyKey(
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    // Capture snapshot of form state at preview time
    const snapshot = {
      componentTypeFormData: formState.componentTypeFormData,
      traitFormDataMap: formState.traitFormDataMap,
      workloadFormData: formState.workloadFormData,
    };

    try {
      const result = await client.previewGitOpsOverrides(
        entity,
        environmentName,
        {
          componentTypeEnvironmentConfigs: formState.componentTypeFormData,
          traitEnvironmentConfigs: formState.traitFormDataMap,
          workloadOverrides: formState.workloadFormData,
        },
      );
      if (!result.valid) {
        setPreviewError(
          result.error ||
            (result.error?.includes('not configured')
              ? result.error
              : 'The override preview is invalid. GitOps target may not be configured. Please contact your platform administrator.'),
        );
      } else {
        previewSnapshot.current = snapshot;
        setPreviewResult(result);
        setPreviewIsStale(false);
      }
    } catch (err) {
      setPreviewError(getErrorMessage(err));
      // Preserve editor values on error (no state reset)
    } finally {
      setPreviewLoading(false);
    }
  };

  // Delete handler: all delete operations only update local editor state.
  // No direct ReleaseBinding API calls are made from this page.
  const handleCreatePullRequest = async () => {
    if (!previewResult || previewIsStale || !previewResult.changed) {
      return;
    }
    if (!previewResult.originalSha) {
      setPrError('Missing preview SHA. Please generate a new preview.');
      return;
    }

    setPrLoading(true);
    setPrError(null);

    try {
      let key = idempotencyKey;
      if (!key) {
        key =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setIdempotencyKey(key);
      }

      const result = await client.createGitOpsOverridePullRequest(
        entity,
        environmentName,
        {
          componentTypeEnvironmentConfigs: formState.componentTypeFormData,
          traitEnvironmentConfigs: formState.traitFormDataMap,
          workloadOverrides: formState.workloadFormData,
          expectedSha: previewResult.originalSha,
          idempotencyKey: key,
        },
      );

      if (result.changed === false) {
        setPrResult(result);
        setPrError(null);
        return;
      }

      if (result.success && result.pullRequest?.url) {
        setPrResult(result);
        setPrError(null);
      } else if (result.error) {
        setPrError(result.error);
      } else {
        setPrError('Failed to create pull request.');
      }
    } catch (err: any) {
      const message = getErrorMessage(err);
      // Check if it's a 409 conflict
      if (
        err?.status === 409 ||
        err?.statusCode === 409 ||
        err?.response?.status === 409 ||
        err?.cause?.status === 409 ||
        message.toLowerCase().includes('conflict')
      ) {
        setPreviewIsStale(true);
        setPrError(
          'The GitOps manifest has changed since your preview. Please generate a new preview before creating a pull request.',
        );
        setIdempotencyKey(
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
      } else {
        setPrError(message);
      }
    } finally {
      setPrLoading(false);
    }
  };

  const handleDeleteClick = (target: 'all' | 'component' | string) => {
    setDeleteTarget(target);
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;

    if (deleteTarget === 'all') {
      // Reset all local form state to empty — does NOT call any API
      setComponentTypeFormData({});
      setTraitFormDataMap({});
      setWorkloadFormData({});
    } else if (deleteTarget === 'component') {
      setComponentTypeFormData({});
    } else if (deleteTarget === 'workload') {
      setWorkloadFormData({});
    } else {
      // Delete specific trait overrides
      setTraitFormDataMap(prev => {
        const newMap = { ...prev };
        delete newMap[deleteTarget];
        return newMap;
      });
    }

    setShowDeleteConfirm(false);
    setDeleteTarget(null);
  };

  const hasSchemas =
    schemas.componentTypeSchema ||
    Object.keys(schemas.traitSchemasMap).length > 0;

  // Workload overrides are always available for deployed components,
  // so we always have content to show even without schema overrides.
  const hasAnyContent = hasSchemas || tabs.length > 0;

  // Handle back button click with unsaved changes warning
  const handleBackClick = () => {
    if (totalChanges > 0) {
      setShowUnsavedChangesDialog(true);
    } else {
      onBack();
    }
  };

  // Determine button text — always GitOps preview flow
  const getPreviewButtonText = () => {
    if (previewLoading) return 'Generating Preview...';
    return 'Preview Changes';
  };

  // Get the warning message for missing required fields
  const getRequiredFieldsWarningMessage = () => {
    if (!pendingAction) {
      return 'Fill in the required fields below before saving.';
    }
    if (pendingAction.type === 'deploy') {
      return `Fill in the required fields below before deploying to ${pendingAction.targetEnvironment}.`;
    }
    return `Fill in the required fields below before promoting to ${pendingAction.targetEnvironment}.`;
  };

  // Title reflects the user's intent (deploy / promote) so they don't lose
  // context on the overrides page. Falls back to today's "Configure overrides"
  // wording when there's no pending action (editing an existing binding).
  const getPageTitle = () => {
    if (previewResult) return 'Review GitOps Changes';
    if (!pendingAction) return 'Configure overrides';
    const blocking = missingRequiredFields.length > 0;
    if (blocking)
      return `Required overrides for ${pendingAction.targetEnvironment}`;
    return pendingAction.type === 'deploy'
      ? `Deploy to ${pendingAction.targetEnvironment}`
      : `Promote to ${pendingAction.targetEnvironment}`;
  };

  const getPageSubtitle = () => {
    if (previewResult) {
      return `${previewResult.repository} · ${previewResult.baseBranch} · ${environment.name}`;
    }
    if (!pendingAction) return environment.name;
    const blocking = missingRequiredFields.length > 0;
    if (blocking) {
      return pendingAction.type === 'deploy'
        ? 'Fill in the required fields below before deploying.'
        : 'Fill in the required fields below before promoting.';
    }
    if (pendingAction.type === 'promote' && pendingAction.sourceEnvironment) {
      return `Review environment overrides in ${pendingAction.targetEnvironment} before promoting from ${pendingAction.sourceEnvironment}.`;
    }
    return pendingAction.type === 'deploy'
      ? `Review environment overrides in ${pendingAction.targetEnvironment} before deploying.`
      : `Review environment overrides in ${pendingAction.targetEnvironment} before promoting.`;
  };

  // Header actions
  const showActions = !loading && !loadError && (hasAnyContent || pendingAction);
  const headerActions = showActions ? (
    <>
      {!previewResult && (
        <Button
          onClick={() => handleDeleteClick('all')}
          color="secondary"
          disabled={previewLoading || loading || !initialOverrides.hasAny}
          data-testid="delete-all-button"
        >
          Delete All
        </Button>
      )}
      {!previewResult &&
        pendingAction?.releaseName &&
        environment.deployment.releaseName && (
          <Tooltip
            title={
              pendingAction.type === 'promote'
                ? "Compare the source release with this environment's current release"
                : "Compare the selected release with this environment's current release"
            }
          >
            <span>
              <Button
                onClick={() => setDiffOpen(true)}
                variant="outlined"
                startIcon={<CompareArrowsIcon fontSize="small" />}
                disabled={previewLoading}
                style={{ marginRight: 8 }}
              >
                View release diff
              </Button>
            </span>
          </Tooltip>
        )}
      {!previewResult && pendingAction && onPrevious && (
        <Button
          onClick={onPrevious}
          variant="outlined"
          disabled={previewLoading}
          style={{ marginRight: 8 }}
        >
          Previous
        </Button>
      )}
      <Button
        onClick={
          previewResult
            ? () => {
                setPreviewResult(null);
                setPrResult(null);
                setPrError(null);
              }
            : handlePreviewClick
        }
        variant="contained"
        color="primary"
        disabled={
          previewResult
            ? previewLoading
            : previewLoading ||
              loading ||
              !!loadError ||
              missingRequiredFields.length > 0 ||
              isWorkloadRowEditing ||
              totalChanges === 0
        }
      >
        {previewResult ? 'Back to Editor' : getPreviewButtonText()}
      </Button>
      {previewResult && (
        <Button
          variant="outlined"
          color="primary"
          onClick={handleCreatePullRequest}
          disabled={
            prLoading ||
            previewIsStale ||
            !previewResult.valid ||
            !previewResult.changed ||
            !!prResult?.pullRequest
          }
          style={{ marginLeft: 8 }}
          data-testid="create-pr-button"
        >
          {prLoading ? 'Creating GitHub Pull Request...' : 'Create Pull Request'}
        </Button>
      )}
    </>
  ) : null;

  // Render content for active tab
  const renderTabContent = () => {
    if (activeTab === 'component' && schemas.componentTypeSchema) {
      return (
        <OverrideContent
          title="Component Overrides"
          schema={schemas.componentTypeSchema}
          formData={formState.componentTypeFormData}
          onChange={setComponentTypeFormData}
          onDelete={() => handleDeleteClick('component')}
          hasInitialData={initialOverrides.hasComponentOverrides}
          disabled={previewLoading}
          showValidation
        />
      );
    }

    // Check for trait tabs
    if (activeTab.startsWith('trait-')) {
      const traitName = activeTab.replace('trait-', '');
      const traitSchema = schemas.traitSchemasMap[traitName];
      if (traitSchema) {
        // Get trait type from the map, fallback to generic "Trait" if not found
        const traitType = traitTypeMap[traitName] || 'trait';

        return (
          <OverrideContent
            title={`${traitName} Trait`}
            contentTitle={
              <>
                <Box display="flex" alignItems="center" gridGap={4} mb={4}>
                  <Typography variant="h4">{traitName}</Typography>
                  <Typography variant="h4" color="textSecondary">
                    ({traitType})
                  </Typography>
                </Box>
                <TraitParameters
                  entity={entity}
                  traitInstanceName={traitName}
                />
              </>
            }
            sectionTitle={
              <Box mb={2}>
                <Typography variant="h5" gutterBottom>
                  Overrides
                </Typography>
              </Box>
            }
            schema={traitSchema}
            formData={formState.traitFormDataMap[traitName] || {}}
            onChange={newData =>
              setTraitFormDataMap(prev => ({
                ...prev,
                [traitName]: newData,
              }))
            }
            onDelete={() => handleDeleteClick(traitName)}
            hasInitialData={
              !!formState.initialTraitFormDataMap[traitName] &&
              Object.keys(formState.initialTraitFormDataMap[traitName]).length >
                0
            }
            disabled={previewLoading}
            showValidation
          />
        );
      }
    }

    if (activeTab === 'workload') {
      return (
        <OverrideContent
          title="Workload Overrides"
          schema={null} // No JSON schema for workload overrides
          formData={formState.workloadFormData}
          onChange={setWorkloadFormData}
          onDelete={() => handleDeleteClick('workload')}
          hasInitialData={initialOverrides.hasWorkloadOverrides}
          wrapCustomContent
          sectionTitle={
            <Box mb={3}>
              <Typography variant="h4">Container</Typography>
            </Box>
          }
          customContent={
            <ContainerContent
              container={formState.workloadFormData.container}
              onContainerChange={handleContainerChange}
              onEnvVarChange={handleEnvVarChange}
              onEnvVarReplace={handleEnvVarReplace}
              onFileVarChange={handleFileVarChange}
              onFileVarReplace={handleFileVarReplace}
              onAddEnvVar={handleAddEnvVar}
              onRemoveEnvVar={handleRemoveEnvVar}
              onAddFileVar={handleAddFileVar}
              onRemoveFileVar={handleRemoveFileVar}
              onArrayFieldChange={handleArrayFieldChange}
              disabled={previewLoading || loading}
              hideContainerFields
              secretReferences={secretReferences}
              baseWorkloadData={formState.baseWorkloadData}
              initialWorkloadData={
                formState.initialWorkloadFormData as
                  | typeof formState.baseWorkloadData
                  | null
              }
              showEnvVarStatus
              onStartOverride={handleStartOverride}
              onStartFileOverride={handleStartFileOverride}
              environmentName={environment.name}
              onEditingChange={setIsWorkloadRowEditing}
            />
          }
        />
      );
    }

    return null;
  };

  return (
    <>
      <DetailPageLayout
        title={getPageTitle()}
        subtitle={getPageSubtitle()}
        onBack={handleBackClick}
        actions={headerActions}
      >
        {previewResult ? (
          <Box>
            <Box mb={2}>
              <Typography variant="body2">
                <strong>Repository:</strong> {previewResult.repository}
              </Typography>
              <Typography variant="body2">
                <strong>Branch:</strong> {previewResult.baseBranch}
              </Typography>
              <Typography variant="body2">
                <strong>Environment:</strong> {environment.name}
              </Typography>
              <Typography variant="body2">
                <strong>File:</strong> {previewResult.manifestPath}
              </Typography>
            </Box>
            {previewIsStale && (
              <Box mb={2}>
                <Alert severity="warning">
                  You have made changes since this preview was generated. Please
                  regenerate the preview to reflect the latest values.
                </Alert>
              </Box>
            )}
            {previewResult.changed ? (
              <Alert severity="success">Validation successful.</Alert>
            ) : (
              <Alert severity="info">
                The proposed overrides produce no YAML changes.
              </Alert>
            )}
            {prError && (
              <Box mt={2}>
                <Alert severity="error">{prError}</Alert>
              </Box>
            )}
            {prResult?.changed === false && (
              <Box mt={2}>
                <Alert severity="info">
                  {prResult.message || 'No changes detected. Nothing needs to be submitted.'}
                </Alert>
              </Box>
            )}
            {prResult?.success && prResult.pullRequest && (
              <Box mt={2}>
                <Alert severity="success">
                  Pull Request #{prResult.pullRequest.number} created successfully.
                </Alert>
                <Box mt={1} display="flex" gridGap={8}>
                  <Button
                    variant="contained"
                    color="primary"
                    startIcon={<LaunchIcon />}
                    onClick={() => {
                      if (prResult.pullRequest?.url) {
                        window.open(prResult.pullRequest.url, '_blank', 'noopener,noreferrer');
                      }
                    }}
                  >
                    Open Pull Request
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => setPrResult(null)}
                  >
                    Back to Editor
                  </Button>
                </Box>
                {prResult.pullRequest.title && (
                  <Box mt={1}>
                    <Typography variant="body2">
                      <strong>Title:</strong> {prResult.pullRequest.title}
                    </Typography>
                  </Box>
                )}
              </Box>
            )}
            {pendingAction && (
              <Box mt={2}>
                <Alert severity="info">
                  This preview prepares a GitOps override pull request; it does
                  not deploy or promote the release. Deployment and promotion
                  happen through their respective workflows after changes are
                  reviewed and merged.
                </Alert>
              </Box>
            )}
            <Box mt={2}>
              <YamlDiffViewer
                original={previewResult.originalManifest}
                modified={previewResult.proposedManifest}
                originalLabel="Current manifest"
                modifiedLabel="Proposed manifest"
                height="55vh"
              />
            </Box>
          </Box>
        ) : (
          <>
            <Alert severity="info" style={{ marginBottom: 16 }}>
              Changes are managed through GitOps. Preview the YAML diff before
              submitting a Pull Request.
            </Alert>
            {previewError && (
              <Box mb={2}>
                <Alert severity="error">{previewError}</Alert>
              </Box>
            )}
            {previewLoading && (
              <Box mb={2} display="flex" alignItems="center" gridGap={8}>
                <CircularProgress size={20} />
                <Typography variant="body2">
                  Fetching the configured manifest and generating a preview...
                </Typography>
              </Box>
            )}
            {loading && (
              <div className={classes.loadingContainer}>
                <CircularProgress />
              </div>
            )}

            {loadError && !loading && (
              <div className={classes.errorContainer}>
                <Typography color="error">{loadError}</Typography>
                <Button onClick={reload} variant="outlined">
                  Retry
                </Button>
              </div>
            )}

            {!loading && !loadError && !hasAnyContent && pendingAction && (
              <Box
                display="flex"
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
                minHeight={300}
                p={4}
              >
                <Typography variant="h6" gutterBottom>
                  No Configuration Required
                </Typography>
                <Typography
                  variant="body2"
                  color="textSecondary"
                  align="center"
                  style={{ marginBottom: 24 }}
                >
                  This component has no environment-specific overrides to
                  configure.
                </Typography>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handlePreviewClick}
                  disabled={
                    previewLoading ||
                    false ||
                    false
                  }
                >
                  {getPreviewButtonText()}
                </Button>
              </Box>
            )}

            {!loading && !loadError && hasAnyContent && (
              <>
                {missingRequiredFields.length > 0 && (
                  <Box mb={2}>
                    <Alert severity="warning">
                      <strong>Required configuration needed.</strong>{' '}
                      {getRequiredFieldsWarningMessage()}
                    </Alert>
                  </Box>
                )}

                {!currentOverrides.hasAny && !pendingAction && (
                  <Box className={classes.helpText}>
                    <Typography variant="body2" gutterBottom>
                      <strong>Environment Overrides</strong>
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Configure environment-specific settings for your
                      component's containers, such as environment variables and
                      file mounts. These overrides apply only to the{' '}
                      <strong>{environment.name}</strong> environment.
                    </Typography>
                  </Box>
                )}

                {tabs.length > 0 && (
                  <VerticalTabNav
                    tabs={tabs}
                    activeTabId={activeTab}
                    onChange={setActiveTab}
                    className={classes.tabNav}
                  >
                    {renderTabContent()}
                  </VerticalTabNav>
                )}

                {tabs.length === 0 && (
                  <Box
                    p={2}
                    style={{
                      backgroundColor: '#f5f5f5',
                      borderRadius: '4px',
                    }}
                  >
                    <Typography variant="body2" color="textSecondary">
                      No configuration options available for this component.
                    </Typography>
                  </Box>
                )}
              </>
            )}
          </>
        )}
      </DetailPageLayout>

      <DeleteConfirmationDialog
        open={showDeleteConfirm}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setDeleteTarget(null);
        }}
        onConfirm={handleConfirmDelete}
        deleteTarget={deleteTarget}
        initialComponentTypeFormData={formState.initialComponentTypeFormData}
        initialTraitFormDataMap={formState.initialTraitFormDataMap}
        deleting={false}
      />

      <UnsavedChangesDialog
        open={showUnsavedChangesDialog}
        onDiscard={() => {
          setShowUnsavedChangesDialog(false);
          onBack();
        }}
        onStay={() => setShowUnsavedChangesDialog(false)}
        changeCount={totalChanges}
      />

      {pendingAction?.releaseName && (
        <ComponentReleaseDiffDialog
          open={diffOpen}
          onClose={() => setDiffOpen(false)}
          upstreamEnvName={
            pendingAction.type === 'promote'
              ? pendingAction.sourceEnvironment
              : 'Selected release'
          }
          upstreamReleaseName={pendingAction.releaseName}
          environmentName={environment.name}
          releaseName={environment.deployment.releaseName}
        />
      )}
    </>
  );
};
