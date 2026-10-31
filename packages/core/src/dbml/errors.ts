/**
 * The error every DBML writer throws when it will not edit a file: the file
 * does not parse, breaks a rule the reader reports, or the edit itself would
 * write something DBML refuses. The provider shows it as the existing
 * "can't edit" toast; commands show it as a modal with the file and an Open
 * File button.
 */
export class DbmlEditRefused extends Error {
  constructor(
    /** The file refused, as the caller named it. */
    readonly file: string,
    message: string,
    /** 1-based line of the problem, when there is one. */
    readonly line?: number,
  ) {
    super(message);
    this.name = 'DbmlEditRefused';
  }
}
