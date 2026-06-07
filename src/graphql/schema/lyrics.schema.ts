export const lyricsSchema = `
  type Lyrics {
    id: ID!
    projectId: String!
    editorMode: String!
    language: String
    lines: [Line!]!
    version: Int
    createdAt: String
    updatedAt: String
  }

  type Translation {
    language: String!
    text: String!
  }

  type Line {
    type: String
    label: String
    depth: Int
    text: String
    timestamp: Float
    endTime: Float
    secondary: String
    singers: [String!]
    translation: String
    translations: [Translation!]
    words: [Word!]
    secondaryWords: [SecondaryWord!]
  }

  type Word {
    word: String!
    time: Float
    reading: String
  }

  type SecondaryWord {
    word: String!
    time: Float
  }

  input UpdateLyricsInput {
    editorMode: String
    language: String
    lines: [LineInput!]
  }
`;
