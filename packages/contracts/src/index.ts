export const INSTALLATION_BODY_BYTES = 131072;

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

export type InstallationCapabilities = { "actions": (string)[]; "channels": (string)[]; "richImages": boolean };
export type InstallationBootstrap = { "installationId": string; "appId": string; "platform": "ios" | "android"; "environment": "development" | "production"; "capability": string };
export type InstallationMutation = { "requestId": string; "bindingGeneration": number; "revision": number };
export type InstallationBindingInput = { "requestId": string; "bindingGeneration": number; "revision": number; "userId": string | null };
export type InstallationFactsInput = { "requestId": string; "bindingGeneration": number; "revision": number; "permission": "unknown" | "not_determined" | "denied" | "provisional" | "granted"; "consent": boolean; "capabilities": InstallationCapabilities };
export type InstallationTokenInput = { "requestId": string; "bindingGeneration": number; "revision": number; "tokenRevision": number; "token": string | null };
export type InstallationState = { "id": string; "appId": string; "platform": "ios" | "android"; "environment": "development" | "production"; "userId": string | null; "bindingGeneration": number; "revision": number; "tokenRevision": number; "hasToken": boolean; "permission": "unknown" | "not_determined" | "denied" | "provisional" | "granted"; "consent": boolean; "capabilities": InstallationCapabilities; "lastActiveAt": number | null; "createdAt": number };
export type InstallationResponse = { "installation": InstallationState };
export type InstallationList = { "installations": (InstallationState)[]; "page": number; "perPage": number; "total": number };

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
  }
} as const;
