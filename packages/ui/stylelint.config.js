// Component CSS may only use design tokens: no raw colours, no raw lengths for spacing, radius or type.
const lengthProps =
  '/^(margin|padding|gap|row-gap|column-gap|border-radius|font-size|line-height)/';

export default {
  ignoreFiles: ['src/styles/tokens.css'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': [
      'rgb',
      'rgba',
      'hsl',
      'hsla',
      'hwb',
      'lab',
      'lch',
      'oklab',
      'oklch',
    ],
    'declaration-property-value-allowed-list': {
      [lengthProps]: [
        '/^(0|auto|inherit|initial|unset|none|normal|var\\(.+\\)|calc\\(.*var\\(.+\\).*\\)|.*\\bvar\\(.+\\).*)$/',
      ],
    },
  },
};
