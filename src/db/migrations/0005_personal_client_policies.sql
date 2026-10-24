CREATE TABLE personal_client_policies (
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('static', 'oauth')),
  principal_id TEXT NOT NULL,
  sensitivities TEXT NOT NULL DEFAULT '["general"]',
  categories TEXT NOT NULL DEFAULT '["*"]',
  actions TEXT NOT NULL DEFAULT '["read","propose"]',
  PRIMARY KEY (principal_kind, principal_id)
);
