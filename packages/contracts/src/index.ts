export { validateSchema, type WireSchema } from "./validate.js";

export const INSTALLATION_BODY_BYTES = 262144;

export const InstallationBootstrapExample: InstallationBootstrap = {
  "installationId": "device_example",
  "appId": "com.example.app",
  "platform": "ios",
  "environment": "development",
  "capability": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};
export const InstallationMutationExample: InstallationMutation = {
  "requestId": "request_example",
  "bindingGeneration": 0,
  "revision": 0
};

export type InstallationCapabilities = { "actions": (string)[]; "channels": (string)[]; "richImages": boolean; "categories"?: ({ "id": string; "actions": ({ "id": string; "title": string })[] })[] };
export type InstallationBootstrap = { "installationId": string; "appId": string; "platform": "ios" | "android"; "environment": "development" | "production"; "capability": string };
export type InstallationMutation = { "requestId": string; "bindingGeneration": number; "revision": number };
export type InstallationBindingInput = { "requestId": string; "bindingGeneration": number; "revision": number; "userId": string | null };
export type InstallationFactsInput = { "requestId": string; "bindingGeneration": number; "revision": number; "permission": "unknown" | "not_determined" | "denied" | "provisional" | "granted"; "consent": boolean; "capabilities": InstallationCapabilities };
export type InstallationTokenInput = { "requestId": string; "bindingGeneration": number; "revision": number; "tokenRevision": number; "token": string | null };
export type InstallationState = { "id": string; "appId": string; "platform": "ios" | "android"; "environment": "development" | "production"; "userId": string | null; "bindingGeneration": number; "revision": number; "tokenRevision": number; "hasToken": boolean; "permission": "unknown" | "not_determined" | "denied" | "provisional" | "granted"; "consent": boolean; "capabilities": InstallationCapabilities; "lastActiveAt": number | null; "createdAt": number };
export type InstallationResponse = { "installation": InstallationState };
export type InstallationList = { "installations": (InstallationState)[]; "page": number; "perPage": number; "total": number };
export type PushContent = { "title": string; "body": string; "destination": { "kind": "website" | "app"; "url": string }; "data"?: { [key: string]: string }; "image"?: string; "actions"?: ({ "id": string; "title": string })[]; "ios"?: { "subtitle"?: string; "sound"?: string; "badge"?: number; "categoryId"?: string }; "android"?: { "channelId": string; "sound"?: string } };
export type PushSettings = { "appId": string; "selection": ({ "kind": "last_active" | "all" }) | ({ "kind": "specific"; "installationId": string }); "ttlSeconds"?: number; "replacementKey"?: string };
export type PushCredential = ({ "provider": "apns"; "teamId": string; "keyId": string; "topic": string; "privateKey": string }) | ({ "provider": "fcm"; "projectId": string; "clientEmail": string; "privateKey": string });
export type PushCredentialInput = { "appId": string; "platform": "ios" | "android"; "environment": "development" | "production"; "expectedRevision": number; "credential": PushCredential };
export type PushCredentialView = { "id": string; "appId": string; "platform": "ios" | "android"; "environment": "development" | "production"; "revision": number; "validation": "local_valid" };
export type PushCommand = (PushReceiptCommand) | (PushActionCommand) | (PushEventCommand);
export type PushObservationBatch = { "bindingGeneration": number; "commands": (PushCommand)[] };
export type PushEnvelope = { "version": 1; "targetId": string; "attemptId": string; "installationId": string; "bindingGeneration": number; "content": PushContent; "test": boolean };
export type PushProviderOutcome = { "kind": "accepted" | "rejected" | "unknown" | "blocked"; "providerId"?: string; "code"?: string; "retryAfterMs"?: number };
export type PushAttempt = { "id": string; "campaignId": string; "targetId": string; "ordinal": number; "startedAt": number; "slotId": string; "slotRevision": number; "validUntil": number };
export type PushOutcome = { "id": string; "campaignId": string; "attemptId": string; "targetId": string; "observedAt": number; "result": PushProviderOutcome; "slotId": string; "submission": "none" | "confirmed" | "possible" };
export type PushTargetView = { "id": string; "campaignId": string; "deliveryId": string; "userId": string; "externalId": string; "installationId": string; "credentialId": string; "campaignFingerprint": string; "bindingGeneration": number; "tokenRevision": number; "credentialRevision": number; "expiresAt": number; "createdAt": number; "createdOrder": number; "content": PushContent; "replacementKey": string | null; "test": boolean; "slotId": string; "generation": number; "replacesTargetId": string | null };
export type PushObservationView = { "id": string; "campaignId": string; "installationId": string; "userId": string; "digest": string; "bindingGeneration": number; "sequence": number; "order": number; "receivedAt": number; "command": PushCommand; "slotId": string | null };
export type PushConversion = { "id": string; "campaignId": string; "deliveryId": string; "userId": string; "eventId": string; "engagementId": string; "order": number; "convertedAt": number };
export type PushInspection = { "targets": (PushTargetView)[]; "attempts": (PushAttempt)[]; "outcomes": (PushOutcome)[]; "observations": (PushObservationView)[]; "conversions": (PushConversion)[]; "users": { "targeted": number; "accepted": number; "engaged": number; "converted": number }; "devices": { "targeted": number; "attempts": number; "accepted": number; "receiptObserved": number; "receiptUnknown": number; "confirmedSubmissions": number; "possibleSubmissions": number; "preSendBlocks": number; "pendingOutcomes": number; "waiting": number }; "testTargets": number; "page": number; "perPage": number; "evaluatedAt": number; "records": { "targets": number; "attempts": number; "outcomes": number; "observations": number; "conversions": number; "recipients": number; "slots": number }; "pageCounts": { "targets": number; "attempts": number; "outcomes": number; "observations": number; "conversions": number; "recipients": number; "slots": number }; "recipients": (PushRecipientView)[]; "slots": (PushSlotView)[]; "planning": { "waiting": number; "active": number; "closed": number } };
export type PushJson = (null) | (boolean) | (number) | (string) | ((PushJson)[]) | ({ [key: string]: PushJson });
export type PushEventProps = { [key: string]: PushJson };
export type PushReceiptCommand = { "id": string; "sequence": number; "kind": "receipt" | "tap"; "targetId": string; "attemptId": string };
export type PushActionCommand = { "id": string; "sequence": number; "kind": "action"; "targetId": string; "attemptId": string; "actionId": string };
export type PushEventCommand = { "id": string; "sequence": number; "kind": "event"; "event": string; "eventId": string; "props"?: PushEventProps };
export type PushRecipientState = ({ "kind": "active" }) | ({ "kind": "closed"; "reason": string }) | ({ "kind": "waiting"; "reason": string; "checkedAt": number; "recheckAt": number; "delayMs": number });
export type PushSlotState = ({ "kind": "ready"; "at": number }) | ({ "kind": "waiting"; "reason": string; "recheckAt": number }) | ({ "kind": "reserved"; "attemptId": string; "until": number }) | ({ "kind": "accepted"; "acceptanceId": string }) | ({ "kind": "closed"; "reason": string });
export type PushRecipientView = { "id": string; "campaignId": string; "userId": string; "externalId": string; "variantId": string; "deliveryId": string | null; "state": PushRecipientState; "test": boolean };
export type PushSlotView = { "id": string; "recipientId": string; "campaignId": string; "userId": string; "installationId": string; "targetId": string | null; "generation": number; "revision": number; "sequence": number; "submissionsUsed": number; "expiresAt": number; "uncertain": boolean; "authRefreshRevision": number | null; "state": PushSlotState; "test": boolean; "submissionNotBefore": number; "repair": PushSlotRepair };
export type PushTestInput = { "installationId": string; "requestId": string };
export type PushSlotRepair = (null) | ({ "kind": "credential"; "credentialRevision": number }) | ({ "kind": "payload"; "credentialRevision": number; "campaignFingerprint": string });
export type InAppDecisionInput = { "userId": string; "entryId": string; "requestId": string; "path": string };
export type InAppFeedbackInput = { "userId": string; "type": "shown" | "clicked" | "dismissed" | "converted"; "feedbackId": string };
export type InAppFeedbackReceipt = { "userId": string; "deliveryId": string; "type": "shown" | "clicked" | "dismissed" | "converted"; "receiptId": string; "acknowledgedAt": number };

export const installationSchemas = {
  "InstallationCapabilities": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "actions": {
        "type": "array",
        "maxItems": 32,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "channels": {
        "type": "array",
        "maxItems": 64,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "richImages": {
        "type": "boolean"
      },
      "categories": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "actions"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "actions": {
              "type": "array",
              "maxItems": 4,
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64,
                    "pattern": "^[a-zA-Z0-9_-]+$"
                  },
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  }
                },
                "required": [
                  "id",
                  "title"
                ],
                "additionalProperties": false
              }
            }
          }
        }
      }
    },
    "required": [
      "actions",
      "channels",
      "richImages"
    ]
  },
  "InstallationBootstrap": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "installationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "appId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "platform": {
        "type": "string",
        "enum": [
          "ios",
          "android"
        ]
      },
      "environment": {
        "type": "string",
        "enum": [
          "development",
          "production"
        ]
      },
      "capability": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{43,128}$",
        "minLength": 43,
        "maxLength": 128
      }
    },
    "required": [
      "installationId",
      "appId",
      "platform",
      "environment",
      "capability"
    ],
    "example": {
      "installationId": "device_example",
      "appId": "com.example.app",
      "platform": "ios",
      "environment": "development",
      "capability": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  },
  "InstallationMutation": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "requestId",
      "bindingGeneration",
      "revision"
    ],
    "example": {
      "requestId": "request_example",
      "bindingGeneration": 0,
      "revision": 0
    }
  },
  "InstallationBindingInput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "userId": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 256,
        "minLength": 1
      }
    },
    "required": [
      "requestId",
      "bindingGeneration",
      "revision",
      "userId"
    ]
  },
  "InstallationFactsInput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "permission": {
        "type": "string",
        "enum": [
          "unknown",
          "not_determined",
          "denied",
          "provisional",
          "granted"
        ]
      },
      "consent": {
        "type": "boolean"
      },
      "capabilities": {
        "$ref": "#/components/schemas/InstallationCapabilities"
      }
    },
    "required": [
      "requestId",
      "bindingGeneration",
      "revision",
      "permission",
      "consent",
      "capabilities"
    ]
  },
  "InstallationTokenInput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "tokenRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "token": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 4096
      }
    },
    "required": [
      "requestId",
      "bindingGeneration",
      "revision",
      "tokenRevision",
      "token"
    ]
  },
  "InstallationState": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "appId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "platform": {
        "type": "string",
        "enum": [
          "ios",
          "android"
        ]
      },
      "environment": {
        "type": "string",
        "enum": [
          "development",
          "production"
        ]
      },
      "userId": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 256
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "tokenRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "hasToken": {
        "type": "boolean"
      },
      "permission": {
        "type": "string",
        "enum": [
          "unknown",
          "not_determined",
          "denied",
          "provisional",
          "granted"
        ]
      },
      "consent": {
        "type": "boolean"
      },
      "capabilities": {
        "$ref": "#/components/schemas/InstallationCapabilities"
      },
      "lastActiveAt": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 0
      },
      "createdAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "id",
      "appId",
      "platform",
      "environment",
      "userId",
      "bindingGeneration",
      "revision",
      "tokenRevision",
      "hasToken",
      "permission",
      "consent",
      "capabilities",
      "lastActiveAt",
      "createdAt"
    ]
  },
  "InstallationResponse": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "installation": {
        "$ref": "#/components/schemas/InstallationState"
      }
    },
    "required": [
      "installation"
    ]
  },
  "InstallationList": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "installations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/InstallationState"
        }
      },
      "page": {
        "type": "integer",
        "minimum": 1
      },
      "perPage": {
        "type": "integer",
        "minimum": 1
      },
      "total": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "installations",
      "page",
      "perPage",
      "total"
    ]
  },
  "PushContent": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "body": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      },
      "destination": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "website",
              "app"
            ]
          },
          "url": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2048
          }
        },
        "required": [
          "kind",
          "url"
        ],
        "additionalProperties": false
      },
      "data": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        "maxProperties": 32
      },
      "image": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      },
      "actions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64,
              "pattern": "^[a-zA-Z0-9_-]+$"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64
            }
          },
          "required": [
            "id",
            "title"
          ],
          "additionalProperties": false
        },
        "maxItems": 4
      },
      "ios": {
        "type": "object",
        "properties": {
          "subtitle": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "sound": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "badge": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "categoryId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "android": {
        "type": "object",
        "properties": {
          "channelId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "sound": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "required": [
          "channelId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "title",
      "body",
      "destination"
    ],
    "additionalProperties": false
  },
  "PushSettings": {
    "type": "object",
    "properties": {
      "appId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "selection": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "last_active",
                  "all"
                ]
              }
            },
            "required": [
              "kind"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "specific"
                ]
              },
              "installationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "kind",
              "installationId"
            ],
            "additionalProperties": false
          }
        ]
      },
      "ttlSeconds": {
        "type": "integer",
        "minimum": 1,
        "maximum": 2419200
      },
      "replacementKey": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": [
      "appId",
      "selection"
    ],
    "additionalProperties": false
  },
  "PushCredential": {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "provider": {
            "type": "string",
            "enum": [
              "apns"
            ]
          },
          "teamId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 10,
            "pattern": "^[A-Z0-9]{10}$"
          },
          "keyId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 10,
            "pattern": "^[A-Z0-9]{10}$"
          },
          "topic": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "privateKey": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384
          }
        },
        "required": [
          "provider",
          "teamId",
          "keyId",
          "topic",
          "privateKey"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "provider": {
            "type": "string",
            "enum": [
              "fcm"
            ]
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 63
          },
          "clientEmail": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "privateKey": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384
          }
        },
        "required": [
          "provider",
          "projectId",
          "clientEmail",
          "privateKey"
        ],
        "additionalProperties": false
      }
    ]
  },
  "PushCredentialInput": {
    "type": "object",
    "properties": {
      "appId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "platform": {
        "type": "string",
        "enum": [
          "ios",
          "android"
        ]
      },
      "environment": {
        "type": "string",
        "enum": [
          "development",
          "production"
        ]
      },
      "expectedRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "credential": {
        "$ref": "#/components/schemas/PushCredential"
      }
    },
    "required": [
      "appId",
      "platform",
      "environment",
      "expectedRevision",
      "credential"
    ],
    "additionalProperties": false
  },
  "PushCredentialView": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "appId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "platform": {
        "type": "string",
        "enum": [
          "ios",
          "android"
        ]
      },
      "environment": {
        "type": "string",
        "enum": [
          "development",
          "production"
        ]
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "validation": {
        "type": "string",
        "enum": [
          "local_valid"
        ]
      }
    },
    "required": [
      "id",
      "appId",
      "platform",
      "environment",
      "revision",
      "validation"
    ],
    "additionalProperties": false
  },
  "PushCommand": {
    "oneOf": [
      {
        "$ref": "#/components/schemas/PushReceiptCommand"
      },
      {
        "$ref": "#/components/schemas/PushActionCommand"
      },
      {
        "$ref": "#/components/schemas/PushEventCommand"
      }
    ]
  },
  "PushObservationBatch": {
    "type": "object",
    "properties": {
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "commands": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushCommand"
        },
        "maxItems": 32,
        "minItems": 1
      }
    },
    "required": [
      "bindingGeneration",
      "commands"
    ],
    "additionalProperties": false
  },
  "PushEnvelope": {
    "type": "object",
    "properties": {
      "version": {
        "type": "integer",
        "enum": [
          1
        ]
      },
      "targetId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "attemptId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "installationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "content": {
        "$ref": "#/components/schemas/PushContent"
      },
      "test": {
        "type": "boolean"
      }
    },
    "required": [
      "version",
      "targetId",
      "attemptId",
      "installationId",
      "bindingGeneration",
      "content",
      "test"
    ],
    "additionalProperties": false
  },
  "PushProviderOutcome": {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "accepted",
          "rejected",
          "unknown",
          "blocked"
        ]
      },
      "providerId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "retryAfterMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "kind"
    ],
    "additionalProperties": false
  },
  "PushAttempt": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "campaignId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "targetId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "ordinal": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "startedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "slotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "slotRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "validUntil": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "id",
      "campaignId",
      "targetId",
      "ordinal",
      "startedAt",
      "slotId",
      "slotRevision",
      "validUntil"
    ],
    "additionalProperties": false
  },
  "PushOutcome": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "campaignId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "attemptId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "targetId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "observedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "result": {
        "$ref": "#/components/schemas/PushProviderOutcome"
      },
      "slotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "submission": {
        "type": "string",
        "enum": [
          "none",
          "confirmed",
          "possible"
        ]
      }
    },
    "required": [
      "id",
      "campaignId",
      "attemptId",
      "targetId",
      "observedAt",
      "result",
      "slotId",
      "submission"
    ],
    "additionalProperties": false
  },
  "PushTargetView": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "campaignId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "deliveryId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "externalId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "installationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "credentialId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "campaignFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "tokenRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "credentialRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expiresAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "createdAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "createdOrder": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "content": {
        "$ref": "#/components/schemas/PushContent"
      },
      "replacementKey": {
        "type": [
          "string",
          "null"
        ]
      },
      "test": {
        "type": "boolean"
      },
      "slotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "generation": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "replacesTargetId": {
        "type": [
          "string",
          "null"
        ]
      }
    },
    "required": [
      "id",
      "campaignId",
      "deliveryId",
      "userId",
      "externalId",
      "installationId",
      "credentialId",
      "campaignFingerprint",
      "bindingGeneration",
      "tokenRevision",
      "credentialRevision",
      "expiresAt",
      "createdAt",
      "createdOrder",
      "content",
      "replacementKey",
      "test",
      "slotId",
      "generation",
      "replacesTargetId"
    ],
    "additionalProperties": false
  },
  "PushObservationView": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "campaignId": {
        "type": "string"
      },
      "installationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "digest": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingGeneration": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "sequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "order": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "receivedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "command": {
        "$ref": "#/components/schemas/PushCommand"
      },
      "slotId": {
        "type": [
          "string",
          "null"
        ]
      }
    },
    "required": [
      "id",
      "campaignId",
      "installationId",
      "userId",
      "digest",
      "bindingGeneration",
      "sequence",
      "order",
      "receivedAt",
      "command",
      "slotId"
    ],
    "additionalProperties": false
  },
  "PushConversion": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "campaignId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "deliveryId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "eventId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "engagementId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "order": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "convertedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "id",
      "campaignId",
      "deliveryId",
      "userId",
      "eventId",
      "engagementId",
      "order",
      "convertedAt"
    ],
    "additionalProperties": false
  },
  "PushInspection": {
    "type": "object",
    "properties": {
      "targets": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushTargetView"
        },
        "maxItems": 100
      },
      "attempts": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushAttempt"
        },
        "maxItems": 100
      },
      "outcomes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushOutcome"
        },
        "maxItems": 100
      },
      "observations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushObservationView"
        },
        "maxItems": 100
      },
      "conversions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushConversion"
        },
        "maxItems": 100
      },
      "users": {
        "type": "object",
        "properties": {
          "targeted": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "accepted": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "engaged": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "converted": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "targeted",
          "accepted",
          "engaged",
          "converted"
        ],
        "additionalProperties": false
      },
      "devices": {
        "type": "object",
        "properties": {
          "targeted": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "attempts": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "accepted": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "receiptObserved": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "receiptUnknown": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "confirmedSubmissions": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "possibleSubmissions": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "preSendBlocks": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "pendingOutcomes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "waiting": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "targeted",
          "attempts",
          "accepted",
          "receiptObserved",
          "receiptUnknown",
          "confirmedSubmissions",
          "possibleSubmissions",
          "preSendBlocks",
          "pendingOutcomes",
          "waiting"
        ],
        "additionalProperties": false
      },
      "testTargets": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "page": {
        "type": "integer",
        "minimum": 1
      },
      "perPage": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "evaluatedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "records": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "targets": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "attempts": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "outcomes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "observations": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "conversions": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "recipients": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "slots": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "targets",
          "attempts",
          "outcomes",
          "observations",
          "conversions",
          "recipients",
          "slots"
        ]
      },
      "pageCounts": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "targets": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "attempts": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "outcomes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "observations": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "conversions": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "recipients": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "slots": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "targets",
          "attempts",
          "outcomes",
          "observations",
          "conversions",
          "recipients",
          "slots"
        ]
      },
      "recipients": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushRecipientView"
        },
        "maxItems": 100
      },
      "slots": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushSlotView"
        },
        "maxItems": 100
      },
      "planning": {
        "type": "object",
        "properties": {
          "waiting": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "active": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "closed": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "waiting",
          "active",
          "closed"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "targets",
      "attempts",
      "outcomes",
      "observations",
      "conversions",
      "users",
      "devices",
      "testTargets",
      "page",
      "perPage",
      "evaluatedAt",
      "records",
      "pageCounts",
      "recipients",
      "slots",
      "planning"
    ],
    "additionalProperties": false
  },
  "PushJson": {
    "oneOf": [
      {
        "type": "null"
      },
      {
        "type": "boolean"
      },
      {
        "type": "number"
      },
      {
        "type": "string"
      },
      {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/PushJson"
        }
      },
      {
        "type": "object",
        "additionalProperties": {
          "$ref": "#/components/schemas/PushJson"
        }
      }
    ]
  },
  "PushEventProps": {
    "type": "object",
    "additionalProperties": {
      "$ref": "#/components/schemas/PushJson"
    },
    "description": "Full JSON properties, matching track. Maximum compact encoded size is 4096 bytes."
  },
  "PushReceiptCommand": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "sequence": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "receipt",
          "tap"
        ]
      },
      "targetId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "attemptId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "id",
      "sequence",
      "kind",
      "targetId",
      "attemptId"
    ],
    "additionalProperties": false
  },
  "PushActionCommand": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "sequence": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "action"
        ]
      },
      "targetId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "attemptId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "actionId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": [
      "id",
      "sequence",
      "kind",
      "targetId",
      "attemptId",
      "actionId"
    ],
    "additionalProperties": false
  },
  "PushEventCommand": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "sequence": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "kind": {
        "type": "string",
        "enum": [
          "event"
        ]
      },
      "event": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "eventId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "props": {
        "$ref": "#/components/schemas/PushEventProps"
      }
    },
    "required": [
      "id",
      "sequence",
      "kind",
      "event",
      "eventId"
    ],
    "additionalProperties": false
  },
  "PushRecipientState": {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "active"
            ],
            "type": "string"
          }
        },
        "required": [
          "kind"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "closed"
            ],
            "type": "string"
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": [
          "kind",
          "reason"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "waiting"
            ],
            "type": "string"
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "checkedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "recheckAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "delayMs": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "kind",
          "reason",
          "checkedAt",
          "recheckAt",
          "delayMs"
        ],
        "additionalProperties": false
      }
    ]
  },
  "PushSlotState": {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "ready"
            ],
            "type": "string"
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "kind",
          "at"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "waiting"
            ],
            "type": "string"
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "recheckAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "kind",
          "reason",
          "recheckAt"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "reserved"
            ],
            "type": "string"
          },
          "attemptId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "until": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "kind",
          "attemptId",
          "until"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "accepted"
            ],
            "type": "string"
          },
          "acceptanceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": [
          "kind",
          "acceptanceId"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "closed"
            ],
            "type": "string"
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": [
          "kind",
          "reason"
        ],
        "additionalProperties": false
      }
    ]
  },
  "PushRecipientView": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "campaignId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "externalId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "variantId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "deliveryId": {
        "type": [
          "string",
          "null"
        ]
      },
      "state": {
        "$ref": "#/components/schemas/PushRecipientState"
      },
      "test": {
        "type": "boolean"
      }
    },
    "required": [
      "id",
      "campaignId",
      "userId",
      "externalId",
      "variantId",
      "deliveryId",
      "state",
      "test"
    ],
    "additionalProperties": false
  },
  "PushSlotView": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "recipientId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "campaignId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "installationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "targetId": {
        "type": [
          "string",
          "null"
        ]
      },
      "generation": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "sequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "submissionsUsed": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expiresAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "uncertain": {
        "type": "boolean"
      },
      "authRefreshRevision": {
        "type": [
          "integer",
          "null"
        ]
      },
      "state": {
        "$ref": "#/components/schemas/PushSlotState"
      },
      "test": {
        "type": "boolean"
      },
      "submissionNotBefore": {
        "type": "number",
        "minimum": 0,
        "description": "Persistent earliest notification submission time. Holds and target generations do not lower this retry floor; expiry remains terminal."
      },
      "repair": {
        "$ref": "#/components/schemas/PushSlotRepair"
      }
    },
    "required": [
      "id",
      "recipientId",
      "campaignId",
      "userId",
      "installationId",
      "targetId",
      "generation",
      "revision",
      "sequence",
      "submissionsUsed",
      "expiresAt",
      "uncertain",
      "authRefreshRevision",
      "state",
      "test",
      "submissionNotBefore",
      "repair"
    ],
    "additionalProperties": false
  },
  "PushTestInput": {
    "type": "object",
    "properties": {
      "installationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "installationId",
      "requestId"
    ],
    "additionalProperties": false
  },
  "PushSlotRepair": {
    "oneOf": [
      {
        "type": "null"
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "credential"
            ]
          },
          "credentialRevision": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "kind",
          "credentialRevision"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "payload"
            ]
          },
          "credentialRevision": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "campaignFingerprint": {
            "type": "string"
          }
        },
        "required": [
          "kind",
          "credentialRevision",
          "campaignFingerprint"
        ],
        "additionalProperties": false
      }
    ]
  },
  "InAppDecisionInput": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "entryId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "path": {
        "type": "string",
        "pattern": "^/",
        "maxLength": 2048
      }
    },
    "required": [
      "userId",
      "entryId",
      "requestId",
      "path"
    ],
    "additionalProperties": false
  },
  "InAppFeedbackInput": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "type": {
        "type": "string",
        "enum": [
          "shown",
          "clicked",
          "dismissed",
          "converted"
        ]
      },
      "feedbackId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "description": "Stable per actual feedback operation. Retry unchanged; distinct committed renders use distinct IDs."
      }
    },
    "required": [
      "userId",
      "type",
      "feedbackId"
    ],
    "additionalProperties": false
  },
  "InAppFeedbackReceipt": {
    "type": "object",
    "properties": {
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "deliveryId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "type": {
        "type": "string",
        "enum": [
          "shown",
          "clicked",
          "dismissed",
          "converted"
        ]
      },
      "receiptId": {
        "type": "string"
      },
      "acknowledgedAt": {
        "type": "number"
      }
    },
    "required": [
      "userId",
      "deliveryId",
      "type",
      "receiptId",
      "acknowledgedAt"
    ],
    "additionalProperties": false
  }
} as const;
