# Project Rules & Memory

## Git Commit Message Convention

- **Sequential Numbering**: Whenever committing any changes locally or pushing to GitHub, you **MUST ALWAYS** include an order-wise sequential number in parentheses at the end of the commit subject line: `(#N)`.
- **Current Sequence**:
  - The next commit **MUST** be: `(#15)`
  - Following commits must increment sequentially: `(#16)`, `(#17)`, `(#18)`, etc.
- **Format**:
  Follow Conventional Commits syntax with the sequential hashtag at the end:
  ```
  <type>(<scope>): <description> (#N)
  ```
  Examples:
  - `feat(config): add memory rules for sequential commit numbering (#13)`
  - `fix(auth): handle edge case in token expiration (#14)`

## Core Development Guidelines

1. **Zero Hardcoded Configuration**:
   - Never hardcode company names, domains, ports, URLs, or secrets in application source files.
   - Always fetch from environment variables (`.env`, `import.meta.env`, `process.env`).
2. **Security & Credentials**:
   - Never commit `.env` or actual secrets to version control.
   - Maintain `.env.example` with strict placeholders only.
3. **Quality & Diagnostics**:
   - Run `npm run check` (Doctor) and `npm test` before committing.
   - Preserve friendly English error formatting for all database, validation, and network errors.
