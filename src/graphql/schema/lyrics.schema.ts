export const lyricsSchema = `
  type Lyrics {
    id: ID!
    publicId: String!
    editorMode: String!
    language: String
    sections: [Section!]!
    version: Int
    createdAt: String
    updatedAt: String
  }

  type Section {
    label: String
    depth: Int
    id: String
    singers: [String!]
    timestamp: Float
    lines: [Line!]!
  }

  type Translation {
    language: String!
    text: String!
  }

  type Line {
    id: String
    text: String
    timestamp: Float
    endTime: Float
    secondary: String
    singers: [String!]
    mode: String
    translation: String
    translations: [Translation!]
    words: [Word!]
    secondaryWords: [Word!]
  }

  type Word {
    word: String!
    time: Float
    reading: String
    singerIndex: Int
  }



  input SectionInput {
    label: String
    depth: Int
    id: String
    singers: [String!]
    timestamp: Float
    lines: [LineInput!]
  }

  input UpdateLyricsInput {
    editorMode: String
    language: String
    sections: [SectionInput!]
  }
`;
