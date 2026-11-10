/**
 * The ERD Studio output channel's name, the Show Logs command and its button.
 *
 * vscode-free so the commands' error actions (unit-tested without a host)
 * can offer the button; the channel itself is made in `activate()`.
 */

/** The output channel, as the Output view's dropdown lists it. */
export const LOG_CHANNEL_NAME = 'ERD Studio';

/** Opens the channel ("ERD Studio: Show Logs"). Registered before the no-project return. */
export const SHOW_LOGS_COMMAND = 'erdStudio.showLogs';

/** The button on an error notification that opens the log. */
export const SHOW_LOGS_BUTTON = 'Show Logs';
