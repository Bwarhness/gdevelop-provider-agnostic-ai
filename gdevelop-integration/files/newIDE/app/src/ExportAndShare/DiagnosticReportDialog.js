// @flow
import { Trans } from '@lingui/macro';
import * as React from 'react';
import Text from '../UI/Text';
import Toggle from '../UI/Toggle';
import { ColumnStackLayout, LineStackLayout } from '../UI/Layout';
import Dialog, { DialogPrimaryButton } from '../UI/Dialog';
import FlatButton from '../UI/FlatButton';
import { mapFor } from '../Utils/MapFor';
import {
  Table,
  TableRow,
  TableRowColumn,
  TableBody,
  TableHeader,
  TableHeaderColumn,
} from '../UI/Table';
import GDevelopThemeContext from '../UI/Theme/GDevelopThemeContext';
import PreferencesContext from '../MainFrame/Preferences/PreferencesContext';
import AlertMessage from '../UI/AlertMessage';
import {
  scanProjectForValidationErrors,
  groupValidationErrors,
  type ValidationError,
} from '../Utils/EventsValidationScanner';
import { getFunctionNameFromType } from '../EventsFunctionsExtensionsLoader';
import Link from '../UI/Link';
import IconButton from '../UI/IconButton';
import ChevronArrowRight from '../UI/CustomSvgIcons/ChevronArrowRight';
import ChevronArrowBottom from '../UI/CustomSvgIcons/ChevronArrowBottom';
import type { EventPath } from '../Utils/EventPath';

const gd: libGDevelop = global.gd;

const styles = {
  table: {
    tableLayout: 'fixed',
    width: '100%',
  },
  locationCell: {
    width: '33%',
    verticalAlign: 'top',
  },
  locationText: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
  },
  instructionCell: {
    width: '67%',
    overflow: 'hidden',
  },
  instructionContent: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    width: '100%',
  },
  instructionTextCollapsed: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  },
  instructionTextExpanded: {
    flex: 1,
    wordBreak: 'break-word',
    whiteSpace: 'normal',
    minWidth: 0,
  },
  expandButtonContainer: {
    flexShrink: 0,
    marginLeft: 'auto',
  },
  expandButton: {
    padding: 4,
  },
  typeLabel: {
    fontWeight: 'bold',
  },
};

type InvalidParameterRowProps = {|
  error: ValidationError,
  navigateToError: (error: ValidationError) => void,
  backgroundColor: string,
|};

// Threshold for assuming text might be truncated in the table cell
const TRUNCATION_THRESHOLD_CHARS = 60;

const InvalidParameterRow = ({
  error,
  navigateToError,
  backgroundColor,
}: InvalidParameterRowProps) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const typeLabel = error.isCondition ? 'Condition' : 'Action';
  const couldBeTruncated =
    error.instructionSentence.length > TRUNCATION_THRESHOLD_CHARS;

  return (
    <TableRow
      style={{
        backgroundColor,
      }}
    >
      {/* $FlowFixMe[incompatible-type] */}
      <TableRowColumn style={styles.locationCell}>
        <div style={styles.locationText}>
          <Link href="#" onClick={() => navigateToError(error)}>
            {`${error.locationType}: ${error.locationName}`}
          </Link>
        </div>
      </TableRowColumn>
      {/* $FlowFixMe[incompatible-type] */}
      <TableRowColumn style={styles.instructionCell}>
        <div style={styles.instructionContent}>
          <div
            style={{
              ...(isExpanded
                ? styles.instructionTextExpanded
                : styles.instructionTextCollapsed),
              cursor: couldBeTruncated ? 'pointer' : 'default',
            }}
            onClick={
              couldBeTruncated ? () => setIsExpanded(!isExpanded) : undefined
            }
            title={
              couldBeTruncated && !isExpanded
                ? error.instructionSentence
                : undefined
            }
          >
            <span style={styles.typeLabel}>{typeLabel}</span>{' '}
            {error.instructionSentence}
          </div>
          {couldBeTruncated && (
            <div style={styles.expandButtonContainer}>
              {/* $FlowFixMe[incompatible-type] */}
              <IconButton
                size="small"
                style={styles.expandButton}
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? <ChevronArrowBottom /> : <ChevronArrowRight />}
              </IconButton>
            </div>
          )}
        </div>
      </TableRowColumn>
    </TableRow>
  );
};

type InvalidParametersSectionProps = {|
  validationErrors: Array<ValidationError>,
  invalidParametersCount: number,
  navigateToError: (error: ValidationError) => void,
  gdevelopTheme: any,
|};

const InvalidParametersSection = ({
  validationErrors,
  invalidParametersCount,
  navigateToError,
  gdevelopTheme,
}: InvalidParametersSectionProps) => {
  return (
    <ColumnStackLayout noMargin>
      <Text size="block-title">
        <Trans>Invalid parameters in events ({invalidParametersCount})</Trans>
      </Text>
      <AlertMessage kind="error">
        <Trans>
          The following events have invalid parameters (shown with red underline
          in the events sheet). Click a location to navigate there.
        </Trans>
      </AlertMessage>
      {/* $FlowFixMe[incompatible-type] */}
      <Table style={styles.table}>
        <TableHeader>
          <TableRow>
            {/* $FlowFixMe[incompatible-type] */}
            <TableHeaderColumn style={styles.locationCell}>
              <Trans>Location</Trans>
            </TableHeaderColumn>
            {/* $FlowFixMe[incompatible-type] */}
            <TableHeaderColumn style={styles.instructionCell}>
              <Trans>Instruction</Trans>
            </TableHeaderColumn>
          </TableRow>
        </TableHeader>
        <TableBody>
          {validationErrors
            .filter(error => error.type !== 'missing-instruction')
            .map((error, index) => (
              <InvalidParameterRow
                key={`${error.locationName}-${error.eventPath.join('-')}-${
                  error.instructionType
                }-${error.parameterIndex ?? ''}-${index}`}
                error={error}
                navigateToError={navigateToError}
                backgroundColor={gdevelopTheme.list.itemsBackgroundColor}
              />
            ))}
        </TableBody>
      </Table>
    </ColumnStackLayout>
  );
};

type Props = {|
  project: gdProject,
  wholeProjectDiagnosticReport: gdWholeProjectDiagnosticReport,
  onClose: () => void,
  // If provided, a "Fix with AI" button is shown when there are issues. It receives a
  // ready-to-send description of all the problems for the Ask AI agent to fix.
  onFixWithAi?: (userRequest: string) => void,
  onNavigateToLayoutEvent: (layoutName: string, eventPath: EventPath) => void,
  onNavigateToExternalEventsEvent: (
    externalEventsName: string,
    eventPath: EventPath
  ) => void,
  onNavigateToExtensionEvent: ({|
    extensionName: string,
    functionName: string,
    behaviorName: ?string,
    objectName: ?string,
    eventPath: EventPath,
  |}) => void,
|};

const addFor = (map: Map<string, Set<string>>, key: string, value: string) => {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(value);
};

export default function DiagnosticReportDialog({
  project,
  wholeProjectDiagnosticReport,
  onClose,
  onFixWithAi,
  onNavigateToLayoutEvent,
  onNavigateToExternalEventsEvent,
  onNavigateToExtensionEvent,
}: Props): React.Node {
  const gdevelopTheme = React.useContext(GDevelopThemeContext);
  const preferences = React.useContext(PreferencesContext);

  // Scan project for validation errors (missing instructions, invalid parameters)
  const validationErrors = React.useMemo<Array<ValidationError>>(
    () => {
      try {
        return scanProjectForValidationErrors(project);
      } catch (error) {
        console.error('Error scanning project for validation errors:', error);
        return [];
      }
    },
    [project]
  );

  const groupedErrors = React.useMemo(
    () => groupValidationErrors(validationErrors),
    [validationErrors]
  );

  const missingInstructionsCount = validationErrors.filter(
    e => e.type === 'missing-instruction'
  ).length;
  const invalidParametersCount = validationErrors.filter(
    e => e.type !== 'missing-instruction'
  ).length;
  const hasMissingInstructions = missingInstructionsCount > 0;
  const hasInvalidParameters = invalidParametersCount > 0;
  const hasValidationErrors = hasMissingInstructions || hasInvalidParameters;

  const navigateToError = React.useCallback(
    (error: ValidationError) => {
      onClose();
      if (error.locationType === 'scene') {
        onNavigateToLayoutEvent(error.locationName, error.eventPath);
      } else if (error.locationType === 'external-events') {
        onNavigateToExternalEventsEvent(error.locationName, error.eventPath);
      } else if (
        error.locationType === 'extension' &&
        error.extensionName &&
        error.functionName
      ) {
        onNavigateToExtensionEvent({
          extensionName: error.extensionName,
          functionName: error.functionName,
          behaviorName: error.behaviorName || null,
          objectName: error.objectName || null,
          eventPath: error.eventPath,
        });
      }
    },
    [
      onClose,
      onNavigateToLayoutEvent,
      onNavigateToExternalEventsEvent,
      onNavigateToExtensionEvent,
    ]
  );

  const renderMissingInstructionName = (type: string) => {
    const { name, behaviorName } = getFunctionNameFromType(type);
    if (behaviorName) {
      return `${name} (${behaviorName})`;
    }
    return name;
  };

  const renderDiagnosticReport = React.useCallback(
    (diagnosticReport: gdDiagnosticReport) => {
      // TODO Generalize error aggregation when enough errors are handled to have a clearer view.
      const missingSceneVariables = new Set<string>();
      const unknownObjects = new Set<string>();
      const mismatchedTypeObjects = new Set<string>();
      const missingObjectVariablesByObject = new Map<string, Set<string>>();
      const missingBehaviorsByObjects = new Map<string, Set<string>>();
      mapFor(0, diagnosticReport.count(), index => {
        const projectDiagnostic = diagnosticReport.get(index);

        const objectName = projectDiagnostic.getObjectName();
        const type = projectDiagnostic.getType();
        switch (type) {
          case gd.ProjectDiagnostic.UndeclaredVariable:
            if (objectName.length === 0) {
              missingSceneVariables.add(projectDiagnostic.getActualValue());
            } else {
              addFor(
                missingObjectVariablesByObject,
                objectName,
                projectDiagnostic.getActualValue()
              );
            }
            break;

          case gd.ProjectDiagnostic.MissingBehavior:
            const behaviorType = projectDiagnostic.getExpectedValue();
            const isCapability = gd.MetadataProvider.getBehaviorMetadata(
              gd.JsPlatform.get(),
              behaviorType
            ).isHidden();
            if (isCapability) {
              mismatchedTypeObjects.add(objectName);
            } else {
              addFor(missingBehaviorsByObjects, objectName, behaviorType);
            }
            break;

          case gd.ProjectDiagnostic.UnknownObject:
            unknownObjects.add(projectDiagnostic.getActualValue());
            break;

          case gd.ProjectDiagnostic.MismatchedObjectType:
            mismatchedTypeObjects.add(objectName);
            break;

          default:
            break;
        }
      });
      for (const unknownObjectName of unknownObjects) {
        mismatchedTypeObjects.delete(unknownObjectName);
      }

      return (
        <ColumnStackLayout noMargin useLargeSpacer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderColumn />
                <TableHeaderColumn />
              </TableRow>
            </TableHeader>
            <TableBody>
              {unknownObjects.size > 0 && (
                <TableRow
                  key={`missing-objects`}
                  style={{
                    backgroundColor: gdevelopTheme.list.itemsBackgroundColor,
                  }}
                >
                  <TableRowColumn>
                    <Text size="body">
                      <Trans>Missing objects</Trans>
                    </Text>
                  </TableRowColumn>
                  <TableRowColumn>
                    <Text size="body" allowSelection>
                      {[...unknownObjects].join(', ')}
                    </Text>
                  </TableRowColumn>
                </TableRow>
              )}
              {mismatchedTypeObjects.size > 0 && (
                <TableRow
                  key={`missing-objects`}
                  style={{
                    backgroundColor: gdevelopTheme.list.itemsBackgroundColor,
                  }}
                >
                  <TableRowColumn>
                    <Text size="body">
                      <Trans>
                        Objects used with wrong actions or conditions
                      </Trans>
                    </Text>
                  </TableRowColumn>
                  <TableRowColumn>
                    <Text size="body" allowSelection>
                      {[...mismatchedTypeObjects].join(', ')}
                    </Text>
                  </TableRowColumn>
                </TableRow>
              )}
              {missingSceneVariables.size > 0 && (
                <TableRow
                  style={{
                    backgroundColor: gdevelopTheme.list.itemsBackgroundColor,
                  }}
                >
                  <TableRowColumn>
                    <Text size="body">
                      <Trans>Missing scene variables</Trans>
                    </Text>
                  </TableRowColumn>
                  <TableRowColumn>
                    <Text size="body" allowSelection>
                      {[...missingSceneVariables].join(', ')}
                    </Text>
                  </TableRowColumn>
                </TableRow>
              )}
              {[...missingObjectVariablesByObject.entries()].map(
                ([objectName, missingVariables]) => (
                  <TableRow
                    key={`missing-object-variables-${objectName}`}
                    style={{
                      backgroundColor: gdevelopTheme.list.itemsBackgroundColor,
                    }}
                  >
                    <TableRowColumn>
                      <Text size="body">
                        <Trans>
                          Missing variables for object "{objectName}"
                        </Trans>
                      </Text>
                    </TableRowColumn>
                    <TableRowColumn>
                      <Text size="body" allowSelection>
                        {[...missingVariables].join(', ')}
                      </Text>
                    </TableRowColumn>
                  </TableRow>
                )
              )}
              {[...missingBehaviorsByObjects.entries()].map(
                ([objectName, missingBehaviors]) => (
                  <TableRow
                    key={`missing-object-behaviors-${objectName}`}
                    style={{
                      backgroundColor: gdevelopTheme.list.itemsBackgroundColor,
                    }}
                  >
                    <TableRowColumn>
                      <Text size="body">
                        <Trans>
                          Missing behaviors for object "{objectName}"
                        </Trans>
                      </Text>
                    </TableRowColumn>
                    <TableRowColumn>
                      <Text size="body">
                        {[...missingBehaviors]
                          .map(behaviorType =>
                            gd.MetadataProvider.getBehaviorMetadata(
                              gd.JsPlatform.get(),
                              behaviorType
                            ).getFullName()
                          )
                          .join(', ')}
                      </Text>
                    </TableRowColumn>
                  </TableRow>
                )
              )}
            </TableBody>
          </Table>
        </ColumnStackLayout>
      );
    },
    [gdevelopTheme.list.itemsBackgroundColor]
  );

  // Compose a plain-text description of every problem for the Ask AI agent to fix.
  const handleFixWithAi = React.useCallback(
    () => {
      if (!onFixWithAi) return;
      const sections = [];

      // Missing actions/conditions/expressions, grouped by extension.
      if (groupedErrors.missingInstructions.size > 0) {
        const lines = [];
        for (const [
          extensionName,
          errors,
        ] of groupedErrors.missingInstructions.entries()) {
          const names = [
            ...new Set(
              errors.map(e => renderMissingInstructionName(e.instructionType))
            ),
          ];
          const locations = [
            ...new Set(errors.map(e => `${e.locationType} "${e.locationName}"`)),
          ];
          lines.push(
            `- Extension "${extensionName}": ${names.join(
              ', '
            )} (used in ${locations.join(', ')})`
          );
        }
        sections.push(
          '## Missing actions/conditions/expressions (they no longer exist in their extensions — update or remove them)\n' +
            lines.join('\n')
        );
      }

      // Invalid parameters in events.
      const invalidParameterErrors = validationErrors.filter(
        e => e.type !== 'missing-instruction'
      );
      if (invalidParameterErrors.length > 0) {
        const lines = invalidParameterErrors.map(
          e =>
            `- ${e.locationType} "${e.locationName}": ${
              e.isCondition ? 'Condition' : 'Action'
            } — ${e.instructionSentence}`
        );
        sections.push(
          '## Events with invalid parameters\n' + lines.join('\n')
        );
      }

      // Native (C++) per-scene diagnostics.
      mapFor(0, wholeProjectDiagnosticReport.count(), index => {
        const diagnosticReport = wholeProjectDiagnosticReport.get(index);
        if (diagnosticReport.count() === 0) return;

        const missingSceneVariables = new Set<string>();
        const unknownObjects = new Set<string>();
        const mismatchedTypeObjects = new Set<string>();
        const missingObjectVariablesByObject = new Map<string, Set<string>>();
        const missingBehaviorsByObjects = new Map<string, Set<string>>();
        mapFor(0, diagnosticReport.count(), i => {
          const projectDiagnostic = diagnosticReport.get(i);
          const objectName = projectDiagnostic.getObjectName();
          const type = projectDiagnostic.getType();
          switch (type) {
            case gd.ProjectDiagnostic.UndeclaredVariable:
              if (objectName.length === 0) {
                missingSceneVariables.add(projectDiagnostic.getActualValue());
              } else {
                addFor(
                  missingObjectVariablesByObject,
                  objectName,
                  projectDiagnostic.getActualValue()
                );
              }
              break;
            case gd.ProjectDiagnostic.MissingBehavior: {
              const behaviorType = projectDiagnostic.getExpectedValue();
              const isCapability = gd.MetadataProvider.getBehaviorMetadata(
                gd.JsPlatform.get(),
                behaviorType
              ).isHidden();
              if (isCapability) {
                mismatchedTypeObjects.add(objectName);
              } else {
                addFor(missingBehaviorsByObjects, objectName, behaviorType);
              }
              break;
            }
            case gd.ProjectDiagnostic.UnknownObject:
              unknownObjects.add(projectDiagnostic.getActualValue());
              break;
            case gd.ProjectDiagnostic.MismatchedObjectType:
              mismatchedTypeObjects.add(objectName);
              break;
            default:
              break;
          }
        });
        for (const unknownObjectName of unknownObjects) {
          mismatchedTypeObjects.delete(unknownObjectName);
        }

        const lines = [];
        if (unknownObjects.size > 0)
          lines.push(`- Missing objects: ${[...unknownObjects].join(', ')}`);
        if (mismatchedTypeObjects.size > 0)
          lines.push(
            `- Objects used with the wrong actions/conditions: ${[
              ...mismatchedTypeObjects,
            ].join(', ')}`
          );
        if (missingSceneVariables.size > 0)
          lines.push(
            `- Missing scene variables: ${[...missingSceneVariables].join(', ')}`
          );
        for (const [
          objectName,
          missingVariables,
        ] of missingObjectVariablesByObject.entries()) {
          lines.push(
            `- Missing variables for object "${objectName}": ${[
              ...missingVariables,
            ].join(', ')}`
          );
        }
        for (const [
          objectName,
          missingBehaviors,
        ] of missingBehaviorsByObjects.entries()) {
          const behaviorNames = [...missingBehaviors].map(behaviorType =>
            gd.MetadataProvider.getBehaviorMetadata(
              gd.JsPlatform.get(),
              behaviorType
            ).getFullName()
          );
          lines.push(
            `- Missing behaviors for object "${objectName}": ${behaviorNames.join(
              ', '
            )}`
          );
        }
        if (lines.length > 0)
          sections.push(
            `## Scene "${diagnosticReport.getSceneName()}"\n` + lines.join('\n')
          );
      });

      const userRequest = [
        'The diagnostic report for my GDevelop game found the problems below. ' +
          'Please fix them by editing the project — create any missing objects, ' +
          'behaviors and variables, correct the invalid event parameters, and ' +
          'replace or remove instructions that no longer exist. Make the changes ' +
          'directly, then briefly summarize what you fixed.',
        ...sections,
      ].join('\n\n');

      onFixWithAi(userRequest);
    },
    // renderMissingInstructionName is a stable inline helper recreated each render;
    // it only reads its argument, so it is safe to omit from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onFixWithAi, groupedErrors, validationErrors, wholeProjectDiagnosticReport]
  );

  const hasNativeReport = wholeProjectDiagnosticReport.hasAnyIssue();
  const hasAnyIssue = hasNativeReport || hasValidationErrors;

  return (
    <Dialog
      id="diagnostic-report-dialog"
      title={<Trans>Diagnostic report</Trans>}
      actions={[
        <FlatButton
          id="close-button"
          key="close"
          label={<Trans>Close</Trans>}
          onClick={onClose}
        />,
        hasAnyIssue && onFixWithAi ? (
          <DialogPrimaryButton
            id="fix-with-ai-button"
            key="fix-with-ai"
            label={<Trans>Fix with AI</Trans>}
            primary
            onClick={handleFixWithAi}
          />
        ) : null,
      ]}
      secondaryActions={[
        <Toggle
          key="report-automatically"
          label={<Trans>Generate report at each preview</Trans>}
          toggled={preferences.values.openDiagnosticReportAutomatically}
          onToggle={(e, check) =>
            preferences.setOpenDiagnosticReportAutomatically(check)
          }
          labelPosition="right"
        />,
      ]}
      onRequestClose={onClose}
      onApply={onClose}
      open
      maxWidth="md"
    >
      <ColumnStackLayout noMargin useLargeSpacer>
        {!hasAnyIssue && (
          <AlertMessage kind="info">
            <Trans>No issues found in your project.</Trans>
          </AlertMessage>
        )}

        {/* Missing instructions from extensions */}
        {hasMissingInstructions && (
          <ColumnStackLayout noMargin>
            <Text size="block-title">
              <Trans>
                Missing actions/conditions/expressions (
                {missingInstructionsCount})
              </Trans>
            </Text>
            <AlertMessage kind="warning">
              <Trans>
                The following actions, conditions, or expressions no longer
                exist in their extensions. This can happen when an extension's
                API has changed or when functionality has been removed. Update
                or remove these instructions.
              </Trans>
            </AlertMessage>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderColumn>
                    <Trans>Extension</Trans>
                  </TableHeaderColumn>
                  <TableHeaderColumn>
                    <Trans>Missing instructions</Trans>
                  </TableHeaderColumn>
                  <TableHeaderColumn>
                    <Trans>Location</Trans>
                  </TableHeaderColumn>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...groupedErrors.missingInstructions.entries()].map(
                  ([extensionName, errors]) => (
                    <TableRow
                      key={`missing-ext-${extensionName}`}
                      style={{
                        backgroundColor:
                          gdevelopTheme.list.itemsBackgroundColor,
                      }}
                    >
                      <TableRowColumn>
                        <Text size="body" color="error">
                          {extensionName}
                        </Text>
                      </TableRowColumn>
                      <TableRowColumn>
                        <Text size="body" allowSelection>
                          {[
                            ...new Set(
                              errors.map(e =>
                                renderMissingInstructionName(e.instructionType)
                              )
                            ),
                          ].join(', ')}
                        </Text>
                      </TableRowColumn>
                      <TableRowColumn>
                        {[
                          ...new Set(
                            errors.map(
                              e => `${e.locationType}: ${e.locationName}`
                            )
                          ),
                        ].map(location => {
                          const error = errors.find(
                            e =>
                              `${e.locationType}: ${e.locationName}` ===
                              location
                          );
                          return (
                            <LineStackLayout key={location} noMargin>
                              <Link
                                href="#"
                                onClick={() => error && navigateToError(error)}
                              >
                                {location}
                              </Link>
                            </LineStackLayout>
                          );
                        })}
                      </TableRowColumn>
                    </TableRow>
                  )
                )}
              </TableBody>
            </Table>
          </ColumnStackLayout>
        )}

        {/* Invalid parameters */}
        {hasInvalidParameters && (
          <InvalidParametersSection
            validationErrors={validationErrors}
            invalidParametersCount={invalidParametersCount}
            navigateToError={navigateToError}
            gdevelopTheme={gdevelopTheme}
          />
        )}

        {/* Native diagnostic report (from C++ code) */}
        {mapFor(0, wholeProjectDiagnosticReport.count(), index => {
          const diagnosticReport = wholeProjectDiagnosticReport.get(index);
          return (
            diagnosticReport.count() > 0 && (
              <ColumnStackLayout
                noMargin
                key={`diagnostic-report-${diagnosticReport.getSceneName()}`}
              >
                <Text size="block-title">
                  {diagnosticReport.getSceneName()}
                </Text>
                {renderDiagnosticReport(diagnosticReport)}
              </ColumnStackLayout>
            )
          );
        })}
      </ColumnStackLayout>
    </Dialog>
  );
}
