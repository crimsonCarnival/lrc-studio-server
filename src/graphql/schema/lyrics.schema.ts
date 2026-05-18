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

  type Line {
    text: String!
    timestamp: Float
    endTime: Float
    secondary: String
    translation: String
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
