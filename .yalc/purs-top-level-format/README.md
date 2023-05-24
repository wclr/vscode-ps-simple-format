# Purs Top Level Format

> 😎 Top level formatting of PureScript source code. Wealth buys space.

This formats only top level code structure by setting an appropriate spacing between top level blocks. It follows ~~opinionated and dogmatic~~ adjusted and balanced, yet simple set of rules, so your code becomes more readable and beautiful (at least on the top level).


## Rules:

- Two (2) empty lines between top level blocks (declarations, functions).

- Two (2) empty lines between `module` declaration and the first `import` statement.

- One (1) empty line between open and qualified imports (following compiler's import formatting rules).

- Single line top level declarations can be squashed together without (0) empty lines between.

- Three (3) empty lines before orphan comments (which often used to denote a new code section).
