#!/usr/bin/env python3
"""
Python Calculator
A simple calculator supporting basic arithmetic operations:
  - Addition (+)
  - Subtraction (-)
  - Multiplication (*)
  - Division (/)
  - Exponentiation (**)
  - Modulo (%)

Usage:
  Run directly: python calculator.py
  Or import: from calculator import Calculator
"""


class Calculator:
    """A basic calculator class with arithmetic operations."""

    def __init__(self):
        self.history = []

    def add(self, a: float, b: float) -> float:
        """Return the sum of a and b."""
        result = a + b
        self._log(a, b, "+", result)
        return result

    def subtract(self, a: float, b: float) -> float:
        """Return the difference of a and b."""
        result = a - b
        self._log(a, b, "-", result)
        return result

    def multiply(self, a: float, b: float) -> float:
        """Return the product of a and b."""
        result = a * b
        self._log(a, b, "*", result)
        return result

    def divide(self, a: float, b: float) -> float:
        """Return the quotient of a and b. Raises ValueError if b is zero."""
        if b == 0:
            raise ValueError("Cannot divide by zero.")
        result = a / b
        self._log(a, b, "/", result)
        return result

    def exponentiate(self, base: float, exp: float) -> float:
        """Return base raised to the power of exp."""
        result = base ** exp
        self._log(base, exp, "**", result)
        return result

    def modulo(self, a: float, b: float) -> float:
        """Return the remainder of a divided by b. Raises ValueError if b is zero."""
        if b == 0:
            raise ValueError("Cannot perform modulo by zero.")
        result = a % b
        self._log(a, b, "%", result)
        return result

    def get_history(self) -> list:
        """Return the operation history."""
        return self.history.copy()

    def clear_history(self):
        """Clear the operation history."""
        self.history.clear()

    def _log(self, a, b, operator, result):
        """Log an operation to history."""
        self.history.append({
            "a": a,
            "b": b,
            "operator": operator,
            "result": result
        })


def display_history(calc: Calculator):
    """Pretty-print the calculator history."""
    history = calc.get_history()
    if not history:
        print("No operations in history.")
        return
    print("\n--- Operation History ---")
    for i, entry in enumerate(history, 1):
        print(f"  {i}. {entry['a']} {entry['operator']} {entry['b']} = {entry['result']}")
    print("-------------------------\n")


def get_number(prompt: str) -> float:
    """Prompt the user for a number, repeating until valid input."""
    while True:
        try:
            return float(input(prompt))
        except ValueError:
            print("  Invalid input. Please enter a valid number.")


def main():
    """Interactive calculator loop."""
    calc = Calculator()
    print("=" * 40)
    print("   Python Calculator")
    print("=" * 40)
    print("Operations: +  -  *  /  **  %")
    print("Type 'history' to view past operations.")
    print("Type 'clear' to clear history.")
    print("Type 'quit' or 'q' to exit.\n")

    while True:
        operation = input("Enter operation (+, -, *, /, **, %) or command: ").strip()

        if operation.lower() in ("quit", "q", "exit"):
            print("Goodbye!")
            break

        if operation.lower() == "history":
            display_history(calc)
            continue

        if operation.lower() == "clear":
            calc.clear_history()
            print("History cleared.")
            continue

        valid_ops = ("+", "-", "*", "/", "**", "%")
        if operation not in valid_ops:
            print("Invalid operation. Please choose from: +, -, *, /, **, %\n")
            continue

        print(f"\n  Operation: {operation}")
        a = get_number("  Enter first number: ")
        b = get_number("  Enter second number: ")

        try:
            if operation == "+":
                result = calc.add(a, b)
            elif operation == "-":
                result = calc.subtract(a, b)
            elif operation == "*":
                result = calc.multiply(a, b)
            elif operation == "/":
                result = calc.divide(a, b)
            elif operation == "**":
                result = calc.exponentiate(a, b)
            elif operation == "%":
                result = calc.modulo(a, b)

            print(f"\n  Result: {a} {operation} {b} = {result}\n")

        except ValueError as e:
            print(f"\n  Error: {e}\n")


if __name__ == "__main__":
    main()
