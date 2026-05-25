/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ZodError, ZodIssue } from 'zod';

type LoggerLike = {
  error: (message: string) => void;
};

type ProcessEvent = 'uncaughtException' | 'unhandledRejection';

type ProcessLike = {
  on: (event: ProcessEvent, handler: (reason: unknown) => void) => unknown;
};

const MAX_ZOD_ISSUES = 5;

const toSingleLine = (value: string): string => value
  .replace(/\r?\n\s*/g, ' | ')
  .replace(/\s{2,}/g, ' ')
  .trim();

const collectZodIssues = (error: ZodError): ZodIssue[] => {
  const issues: ZodIssue[] = [];

  const visit = (issue: ZodIssue) => {
    if (issue.code === 'invalid_union') {
      issue.unionErrors.forEach((unionError) => {
        unionError.issues.forEach(visit);
      });
      return;
    }

    issues.push(issue);
  };

  error.issues.forEach(visit);

  return issues;
};

const formatZodIssue = (issue: ZodIssue): string => {
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';

  return `${path}: ${toSingleLine(issue.message)}`;
};

export const formatErrorForLog = (error: unknown): string => {
  if (error instanceof ZodError) {
    const issues = collectZodIssues(error);
    const visibleIssues = issues.slice(0, MAX_ZOD_ISSUES).map(formatZodIssue);
    const hiddenIssues = issues.length - visibleIssues.length;
    const suffix = hiddenIssues > 0 ? `; +${hiddenIssues} more issue(s)` : '';

    return `Zod validation failed: ${visibleIssues.join('; ')}${suffix}`;
  }

  if (error instanceof Error) {
    return toSingleLine(error.stack ?? error.message);
  }

  if (typeof error === 'string') {
    return toSingleLine(error);
  }

  try {
    return toSingleLine(JSON.stringify(error));
  } catch {
    return toSingleLine(String(error));
  }
};

export const buildErrorLogMessage = (context: string, error: unknown): string => (
  `${context}: ${formatErrorForLog(error)}`
);

export const registerProcessErrorHandlers = (
  processLike: ProcessLike,
  logger: LoggerLike,
  exit: (code: number) => void,
): void => {
  processLike.on('uncaughtException', (error) => {
    logger.error(buildErrorLogMessage('Unhandled exception', error));
    exit(1);
  });

  processLike.on('unhandledRejection', (reason) => {
    logger.error(buildErrorLogMessage('Unhandled promise rejection', reason));
    exit(1);
  });
};