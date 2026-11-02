const objectId = { type: 'string', pattern: '^[a-f0-9]{24}$' };

// Ids feed straight into `new ObjectId()`, which throws (a 500) on anything malformed.
export const markReadSchema = {
  body: {
    type: 'object',
    properties: { ids: { type: 'array', items: objectId, maxItems: 1000 } },
    required: ['ids'],
  },
};

export const dismissSchema = {
  params: {
    type: 'object',
    properties: { id: objectId },
    required: ['id'],
  },
};
