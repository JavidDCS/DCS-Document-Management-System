/**
 * Curated list of common passwords, passphrases, and breach patterns of 12+ characters
 * (squashed: lowercase, alphanumeric only). Sourced from NIST SP 800-63B and SecLists
 * top breach corpuses, company/solar defaults, and common keyboard walks.
 */
export const TOP_COMMON_PASSWORDS: readonly string[] = [
  // DCS / Solar / Enterprise defaults
  'decirclesolar', 'decirclesolar1', 'decirclesolar123', 'decirclesolar2025', 'decirclesolar2026',
  'solarsolar123', 'solar1234567', 'company12345', 'company123456', 'companyname1', 'companypass1',
  'administrator', 'administrator1', 'administrator12', 'administrator123', 'adminadmin12',
  'admin1234567', 'admin12345678', 'superadmin12', 'superadmin123', 'changeme1234', 'changeme12345',
  'changemenow1', 'default12345', 'master123456', 'secret123456', 'secretsecret', 'temporary123',
  'temporary1234', 'temppassword1', 'temp12345678', 'welcome12345', 'welcome123456', 'welcome20251',
  'welcome20261', 'winter202512', 'winter202612', 'spring202512', 'spring202612', 'summer202512',
  'summer202612', 'autumn202512', 'autumn202612', 'january20251', 'january20261', 'february2025',
  'february2026', 'march2025march', 'march2026march',

  // Standard sequential, repeated and keyboard walks (12+ chars)
  '123456789012', '1234567890123', '12345678901234', '123456789012345', '123456123456',
  '123123123123', '111111111111', '000000000000', '987654321012', '987654321987',
  'abcdefghijkl', 'abcdefghijklm', 'abcdefghijklmn', 'abcd1234abcd', 'abcd12345678', 'abc123456789',
  'qwertyuiop12', 'qwertyuiop123', 'qwertyuiop1234', 'qwertyuiopas', 'qwertyuiopasdf',
  'qwerty123456', 'qwertyqwerty', 'asdfghjkl123', 'asdfghjkl1234', 'asdfghjklqwe', 'asdfghjkzxvb',
  'zxcvbnm12345', 'zxcvbnmzxcvb', 'zaq12wsx3edc', '1qaz2wsx3edc', '1q2w3e4r5t6y', '1a2b3c4d5e6f',

  // Common password phrases and breach anchors (12+ chars)
  'password1234', 'password12345', 'password123456', 'password1234567', 'passw0rd1234', 'passw0rd12345',
  'p@ssword1234', 'passwordpassword', 'passwordqwerty', 'passwords123', 'passwordtest',
  'iloveyou1234', 'iloveyou12345', 'iloveyou123456', 'letmein12345', 'letmein123456',
  'trustno1trustno1', 'whatever1234', 'whatever12345', 'sunshine1234', 'sunshine12345',
  'princess1234', 'princess12345', 'football1234', 'football12345', 'baseball1234', 'baseball12345',
  'basketball12', 'basketball123', 'dragon123456', 'monkey123456', 'shadow123456', 'master123456',
  'superman1234', 'batmanbatman', 'pokemon12345', 'starwars1234', 'liverpool123', 'arsenal12345',
  'chelsea12345', 'manchester12', 'barcelona123', 'realmadrid12',

  // Common corporate & IT defaults (12+ chars)
  'mustchange12', 'newpassword1', 'firstpassword', 'initialpass1', 'resetpassword', 'resetpass123',
  'loginlogin12', 'logonlogon12', 'networkadmin', 'systemadmin1', 'sysadmin1234', 'databasesec1',
  'oracleoracle', 'postgressql1', 'sqlserver123', 'dockeradmin1', 'kubernetes12', 'production12',
  'stagingadmin', 'development1', 'testtesttest', 'testing12345', 'test12345678', 'demo12345678',

  // Repeated dictionary combinations
  'coffeecoffee', 'chocolate123', 'helloworld12', 'hello1234567', 'goodmorning1', 'goodafternoon',
  'goodnight123', 'beautiful123', 'foreverandever', 'nevergiveup1', 'justdoit1234', 'stayhumble12',
  'familyfirst1', 'blessed12345', 'freedom12345', 'justice12345', 'americapass1', 'california12',
  'newyorkcity1', 'londonlondon', 'tokyotokyo12', 'sydneysydney'
];
