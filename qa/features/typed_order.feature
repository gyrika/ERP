Feature: Typed shorthand order at the counter
  As a cashier with a customer waiting
  I want to type an order in shorthand
  So that I never have to hunt through the menu

  Background:
    Given an empty bill

  Scenario: Two pizzas with a leave-out and a burger
    When I type "2 L devilled chicken no onion, burger"
    Then the bill has 2 lines
    And line 1 is 2 x "devilled-chicken" size "L" without "no-onion"
    And line 2 is 1 x "chicken-burger"
    And the net amount is Rs 5,450.00

  Scenario Outline: Quantity and size words
    When I type "<typed>"
    Then line 1 is <qty> x "<item>" size "<size>"

    Examples:
      | typed            | qty | item       | size |
      | margherita       | 1   | margherita | M    |
      | 2l margherita    | 2   | margherita | L    |
      | three large bbq chicken | 3 | bbq-chicken | L |
