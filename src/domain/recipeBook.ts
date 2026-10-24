/**
 * The owner's recipes, copied from his "Cheesy Beez System V1" workbook
 * (Recipe_BOM and Production_BOM, Active rows) by scripts/import-recipes.ts.
 * GENERATED: do not edit by hand; change the sheet and run the script again.
 * Tests lock the numbers (recipeBook.test.ts), like the menu.
 *
 * PRODUCTS: what one sold item uses. PREPS: what the kitchen makes in-house, and
 * how much one batch makes. makes: null = the owner has not confirmed the output
 * yet ("Confirm batch output qty" in his sheet): he answers it in the app.
 */
/** waste: the share lost on the way (0.1 = 10%), set in the app; none on his sheet. */
export interface BookLine { name: string; qty: number; unit: string; waste?: number }
export interface Prep { makes: { qty: number; unit: string } | null; lines: BookLine[] }

export const PRODUCTS: Readonly<Record<string, readonly BookLine[]>> = {
  "Alfredo Penne Large": [
    { name: "Penne Boil Batch", qty: 260, unit: "g" },
    { name: "Alfredo Sauce Master Batch", qty: 0.1805, unit: "pcs" },
    { name: "Spaghetti Boil Batch", qty: 260, unit: "g" },
    { name: "Alfredo Sauce Master Batch", qty: 0.1805, unit: "pcs" },
  ],
  "Alfredo Penne Medium": [
    { name: "Penne Boil Batch", qty: 180, unit: "g" },
    { name: "Alfredo Sauce Master Batch", qty: 0.125, unit: "pcs" },
  ],
  "Alfredo Penne Single": [
    { name: "Penne Boil Batch", qty: 90, unit: "g" },
    { name: "Alfredo Sauce Master Batch", qty: 0.0625, unit: "pcs" },
  ],
  "Alfredo Spaghetti Medium": [
    { name: "Spaghetti Boil Batch", qty: 180, unit: "g" },
    { name: "Alfredo Sauce Master Batch", qty: 0.125, unit: "pcs" },
  ],
  "Alfredo Spaghetti Single": [
    { name: "Spaghetti Boil Batch", qty: 90, unit: "g" },
    { name: "Alfredo Sauce Master Batch", qty: 0.0625, unit: "pcs" },
  ],
  "Bacon & Egg Burger": [
    { name: "Burger Bun", qty: 1, unit: "pcs" },
    { name: "Butter", qty: 5, unit: "g" },
    { name: "Lettuce", qty: 4.6, unit: "g" },
    { name: "Mayonnaise", qty: 10, unit: "g" },
    { name: "Ketchup", qty: 10, unit: "g" },
    { name: "Bacon Ends", qty: 40, unit: "g" },
    { name: "Egg", qty: 1, unit: "pcs" },
    { name: "Salt for Egg", qty: 0.5, unit: "g" },
  ],
  "Bacon & Onion Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Bacon", qty: 40, unit: "g" },
    { name: "Onion", qty: 8, unit: "g" },
  ],
  "Bacon & Onion Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Bacon", qty: 60, unit: "g" },
    { name: "Onion", qty: 16, unit: "g" },
  ],
  "BBQ Chicken Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Fried Chicken Cubes", qty: 30, unit: "g" },
    { name: "BBQ Sauce", qty: 8, unit: "ml" },
    { name: "Bell Pepper", qty: 4, unit: "g" },
  ],
  "BBQ Chicken Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Fried Chicken Cubes", qty: 50, unit: "g" },
    { name: "BBQ Sauce", qty: 13, unit: "ml" },
    { name: "Bell Pepper", qty: 8, unit: "g" },
  ],
  "BBQ Mix Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Pussallawa Jumbo Sausage", qty: 0.5, unit: "pcs" },
    { name: "Keells Cheese & Onion Sausage", qty: 0.5, unit: "pcs" },
    { name: "Fried Chicken Cubes", qty: 30, unit: "g" },
    { name: "BBQ Sauce", qty: 13, unit: "ml" },
    { name: "Bell Pepper", qty: 4, unit: "g" },
  ],
  "BBQ Mix Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Pussallawa Jumbo Sausage", qty: 1, unit: "pcs" },
    { name: "Keells Cheese & Onion Sausage", qty: 1, unit: "pcs" },
    { name: "Fried Chicken Cubes", qty: 50, unit: "g" },
    { name: "BBQ Sauce", qty: 26, unit: "ml" },
    { name: "Bell Pepper", qty: 8, unit: "g" },
  ],
  "BBQ Sausages Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Pussallawa Jumbo Sausage", qty: 1, unit: "pcs" },
    { name: "BBQ Sauce", qty: 8, unit: "ml" },
    { name: "Bell Pepper", qty: 4, unit: "g" },
  ],
  "BBQ Sausages Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Pussallawa Jumbo Sausage", qty: 2, unit: "pcs" },
    { name: "BBQ Sauce", qty: 18, unit: "ml" },
    { name: "Bell Pepper", qty: 8, unit: "g" },
  ],
  "Bolognese Minced Chicken Finishing Unit": [
    { name: "Minced Chicken Packet", qty: 100, unit: "g" },
    { name: "Sunflower Oil", qty: 10, unit: "g" },
  ],
  "Bolognese Penne Large": [
    { name: "Penne Boil Batch", qty: 260, unit: "g" },
    { name: "Bolognese Sauce Master Batch", qty: 0.1805, unit: "pcs" },
  ],
  "Bolognese Penne Medium": [
    { name: "Penne Boil Batch", qty: 180, unit: "g" },
    { name: "Bolognese Sauce Master Batch", qty: 0.125, unit: "pcs" },
  ],
  "Bolognese Penne Single": [
    { name: "Penne Boil Batch", qty: 90, unit: "g" },
    { name: "Bolognese Sauce Master Batch", qty: 0.0625, unit: "pcs" },
  ],
  "Bolognese Spaghetti Large": [
    { name: "Spaghetti Boil Batch", qty: 260, unit: "g" },
    { name: "Bolognese Sauce Master Batch", qty: 0.1805, unit: "pcs" },
  ],
  "Bolognese Spaghetti Medium": [
    { name: "Spaghetti Boil Batch", qty: 180, unit: "g" },
    { name: "Bolognese Sauce Master Batch", qty: 0.125, unit: "pcs" },
  ],
  "Bolognese Spaghetti Single": [
    { name: "Spaghetti Boil Batch", qty: 90, unit: "g" },
    { name: "Bolognese Sauce Master Batch", qty: 0.0625, unit: "pcs" },
  ],
  "Cheese & Onion Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Onion", qty: 8, unit: "g" },
  ],
  "Cheese & Onion Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Onion", qty: 16, unit: "g" },
  ],
  "Chicken Alfredo Pasta Large": [
    { name: "Alfredo Chicken Master Batch", qty: 0.1805, unit: "pcs" },
  ],
  "Chicken Alfredo Pasta Medium": [
    { name: "Alfredo Chicken Master Batch", qty: 0.125, unit: "pcs" },
  ],
  "Chicken Alfredo Penne Large": [
    { name: "Alfredo Penne Large", qty: 1, unit: "pcs" },
  ],
  "Chicken Alfredo Penne Medium": [
    { name: "Alfredo Penne Medium", qty: 1, unit: "pcs" },
  ],
  "Chicken Alfredo Penne Single": [
    { name: "Alfredo Penne Single", qty: 1, unit: "pcs" },
    { name: "Alfredo Chicken Master Batch", qty: 0.0625, unit: "pcs" },
  ],
  "Chicken Alfredo Spaghetti Large": [
    { name: "Alfredo Spaghetti Large", qty: 1, unit: "pcs" },
    { name: "Alfredo Chicken Master Batch", qty: 0.1805, unit: "pcs" },
  ],
  "Chicken Alfredo Spaghetti Medium": [
    { name: "Alfredo Spaghetti Medium", qty: 1, unit: "pcs" },
    { name: "Alfredo Chicken Master Batch", qty: 0.125, unit: "pcs" },
  ],
  "Chicken Alfredo Spaghetti Single": [
    { name: "Alfredo Spaghetti Single", qty: 1, unit: "pcs" },
    { name: "Alfredo Chicken Master Batch", qty: 0.0625, unit: "pcs" },
  ],
  "Chicken Bolognese Penne Large": [
    { name: "Bolognese Penne Large", qty: 1, unit: "pcs" },
    { name: "Bolognese Minced Chicken Finishing Unit", qty: 0.1805, unit: "pcs" },
  ],
  "Chicken Bolognese Penne Medium": [
    { name: "Bolognese Penne Medium", qty: 1, unit: "pcs" },
    { name: "Bolognese Minced Chicken Finishing Unit", qty: 0.125, unit: "pcs" },
  ],
  "Chicken Bolognese Penne Single": [
    { name: "Bolognese Penne Single", qty: 1, unit: "pcs" },
    { name: "Bolognese Minced Chicken Finishing Unit", qty: 0.0625, unit: "pcs" },
  ],
  "Chicken Bolognese Spaghetti Large": [
    { name: "Bolognese Spaghetti Large", qty: 1, unit: "pcs" },
    { name: "Bolognese Minced Chicken Finishing Unit", qty: 0.1805, unit: "pcs" },
  ],
  "Chicken Bolognese Spaghetti Medium": [
    { name: "Bolognese Spaghetti Medium", qty: 1, unit: "pcs" },
    { name: "Bolognese Minced Chicken Finishing Unit", qty: 0.125, unit: "pcs" },
  ],
  "Chicken Bolognese Spaghetti Single": [
    { name: "Bolognese Spaghetti Single", qty: 1, unit: "pcs" },
    { name: "Bolognese Minced Chicken Finishing Unit", qty: 0.0625, unit: "pcs" },
  ],
  "Chicken Burger": [
    { name: "Burger Bun", qty: 1, unit: "pcs" },
    { name: "Butter", qty: 5, unit: "g" },
    { name: "Lettuce", qty: 4.6, unit: "g" },
    { name: "Mayonnaise", qty: 10, unit: "g" },
    { name: "Ketchup", qty: 10, unit: "g" },
    { name: "Chicken Patty 50g", qty: 1, unit: "pcs" },
  ],
  "Chicken Devilled Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Fried Chicken Cubes", qty: 30, unit: "g" },
    { name: "Ketchup", qty: 8, unit: "g" },
    { name: "Bell Pepper", qty: 4, unit: "g" },
  ],
  "Chicken Devilled Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Fried Chicken Cubes", qty: 50, unit: "g" },
    { name: "Ketchup", qty: 15, unit: "g" },
    { name: "Bell Pepper", qty: 8, unit: "g" },
  ],
  "Chicken Sausages Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Pussallawa Jumbo Sausage", qty: 1, unit: "pcs" },
    { name: "Ketchup", qty: 8, unit: "g" },
    { name: "Bell Pepper", qty: 4, unit: "g" },
  ],
  "Chicken Sausages Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Pussallawa Jumbo Sausage", qty: 2, unit: "pcs" },
    { name: "Ketchup", qty: 15, unit: "g" },
    { name: "Bell Pepper", qty: 8, unit: "g" },
  ],
  "Crispy Chicken Burger": [
    { name: "Burger Bun", qty: 1, unit: "pcs" },
    { name: "Butter", qty: 5, unit: "g" },
    { name: "Lettuce", qty: 4.6, unit: "g" },
    { name: "Mayonnaise", qty: 10, unit: "g" },
    { name: "Ketchup", qty: 5, unit: "g" },
    { name: "Tomato Slice", qty: 1, unit: "pcs" },
    { name: "Chicken", qty: 70, unit: "g" },
    { name: "Curd", qty: 46.6667, unit: "g" },
    { name: "Salt", qty: 0.2333, unit: "g" },
    { name: "Sugar", qty: 0.56, unit: "g" },
    { name: "MSG", qty: 0.21, unit: "g" },
    { name: "Fresh Garlic", qty: 0.7, unit: "g" },
    { name: "Fresh Ginger", qty: 0.28, unit: "g" },
    { name: "Chili Powder", qty: 0.1167, unit: "g" },
    { name: "A/P Flour", qty: 16.24, unit: "g" },
    { name: "Corn Flour", qty: 4.06, unit: "g" },
    { name: "Salt for Breading", qty: 0.7, unit: "g" },
    { name: "MSG for Breading", qty: 0.21, unit: "g" },
    { name: "Garlic Powder", qty: 0.098, unit: "g" },
    { name: "Paprika", qty: 0.112, unit: "g" },
    { name: "Pepper", qty: 0.175, unit: "g" },
    { name: "Oregano for Breading", qty: 0.049, unit: "g" },
    { name: "Turmeric", qty: 0.07, unit: "g" },
    { name: "Onion Powder", qty: 0.098, unit: "g" },
  ],
  "Crispy Chicken Drumsticks 12 pcs": [
    { name: "Raw Drumstick", qty: 12, unit: "pcs" },
    { name: "Palm Oil", qty: 36, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 6, unit: "pcs" },
  ],
  "Crispy Chicken Drumsticks 2 pcs": [
    { name: "Raw Drumstick", qty: 2, unit: "pcs" },
    { name: "Palm Oil", qty: 6, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 1, unit: "pcs" },
  ],
  "Crispy Chicken Drumsticks 4 pcs": [
    { name: "Raw Drumstick", qty: 4, unit: "pcs" },
    { name: "Palm Oil", qty: 12, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 2, unit: "pcs" },
  ],
  "Crispy Chicken Drumsticks 6 pcs": [
    { name: "Raw Drumstick", qty: 6, unit: "pcs" },
    { name: "Palm Oil", qty: 18, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 3, unit: "pcs" },
  ],
  "Crispy Chicken Drumsticks 8 pcs": [
    { name: "Raw Drumstick", qty: 8, unit: "pcs" },
    { name: "Palm Oil", qty: 24, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 4, unit: "pcs" },
  ],
  "Crispy Chicken Wings 12 pcs": [
    { name: "Raw Wing", qty: 12, unit: "pcs" },
    { name: "Palm Oil", qty: 36, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 6, unit: "pcs" },
  ],
  "Crispy Chicken Wings 2 pcs": [
    { name: "Raw Wing", qty: 2, unit: "pcs" },
    { name: "Palm Oil", qty: 6, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 1, unit: "pcs" },
  ],
  "Crispy Chicken Wings 4 pcs": [
    { name: "Raw Wing", qty: 4, unit: "pcs" },
    { name: "Palm Oil", qty: 12, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 2, unit: "pcs" },
  ],
  "Crispy Chicken Wings 6 pcs": [
    { name: "Raw Wing", qty: 6, unit: "pcs" },
    { name: "Palm Oil", qty: 18, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 3, unit: "pcs" },
  ],
  "Crispy Chicken Wings 8 pcs": [
    { name: "Raw Wing", qty: 8, unit: "pcs" },
    { name: "Palm Oil", qty: 24, unit: "ml" },
    { name: "700ml Cardboard Box", qty: 4, unit: "pcs" },
  ],
  "Egg Burger Bullseye": [
    { name: "Burger Bun", qty: 1, unit: "pcs" },
    { name: "Butter", qty: 5, unit: "g" },
    { name: "Lettuce", qty: 4.6, unit: "g" },
    { name: "Mayonnaise", qty: 10, unit: "g" },
    { name: "Ketchup", qty: 10, unit: "g" },
    { name: "Egg", qty: 1, unit: "pcs" },
  ],
  "Extra Bacon and Egg": [
    { name: "Egg", qty: 1, unit: "pcs" },
    { name: "Bacon Ends", qty: 40, unit: "g" },
  ],
  "Extra Bullseye": [
    { name: "Egg", qty: 1, unit: "pcs" },
  ],
  "Extra Cheese Full Add-on": [
    { name: "Mozzarella Blend", qty: 60, unit: "g" },
  ],
  "Extra Cheese Half Add-on": [
    { name: "Mozzarella Blend", qty: 30, unit: "g" },
  ],
  "Extra Cheese Slice": [
    { name: "Cheese Slice", qty: 1, unit: "pcs" },
  ],
  "Extra Chicken Patty": [
    { name: "Chicken Patty 50g", qty: 1, unit: "pcs" },
  ],
  "Fish Burger": [
    { name: "Burger Bun", qty: 1, unit: "pcs" },
    { name: "Butter", qty: 5, unit: "g" },
    { name: "Lettuce", qty: 4.6, unit: "g" },
    { name: "Mayonnaise", qty: 10, unit: "g" },
    { name: "Ketchup", qty: 10, unit: "g" },
    { name: "Fish Cake Patty 50g", qty: 1, unit: "pcs" },
  ],
  "French Fries Large": [
    { name: "Frozen Fries", qty: 210, unit: "g" },
    { name: "Salt", qty: 1.5, unit: "g" },
  ],
  "French Fries Medium": [
    { name: "Frozen Fries", qty: 140, unit: "g" },
    { name: "Salt", qty: 1, unit: "g" },
  ],
  "French Fries Small": [
    { name: "Frozen Fries", qty: 90, unit: "g" },
    { name: "Salt", qty: 0.5, unit: "g" },
  ],
  "French Fries Tray 1000g": [
    { name: "Frozen Fries", qty: 1000, unit: "g" },
    { name: "Salt", qty: 3, unit: "g" },
  ],
  "French Fries Tray 500g": [
    { name: "Frozen Fries", qty: 500, unit: "g" },
    { name: "Salt", qty: 2, unit: "g" },
  ],
  "Hotdog": [
    { name: "Hotdog Bun", qty: 1, unit: "pcs" },
    { name: "Pussallawa Jumbo Sausage", qty: 1, unit: "pcs" },
    { name: "Tomato Slice", qty: 1, unit: "pcs" },
  ],
  "Margherita Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
  ],
  "Margherita Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
  ],
  "Mini Sausages 1kg Portion": [
    { name: "Cheese & Onion Mini Sausages", qty: 57, unit: "pcs" },
  ],
  "Mini Sausages 250g Portion": [
    { name: "Cheese & Onion Mini Sausages", qty: 14, unit: "pcs" },
  ],
  "Mini Sausages 4 pcs": [
    { name: "Cheese & Onion Mini Sausages", qty: 4, unit: "pcs" },
  ],
  "Mini Sausages 500g Portion": [
    { name: "Cheese & Onion Mini Sausages", qty: 28, unit: "pcs" },
  ],
  "Mini Sausages 8 pcs": [
    { name: "Cheese & Onion Mini Sausages", qty: 8, unit: "pcs" },
  ],
  "Seafood Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Prawns", qty: 3, unit: "pcs" },
    { name: "Tuna", qty: 26, unit: "g" },
    { name: "Bell Pepper", qty: 4, unit: "g" },
  ],
  "Seafood Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Prawns", qty: 5, unit: "pcs" },
    { name: "Tuna", qty: 40, unit: "g" },
    { name: "Bell Pepper", qty: 8, unit: "g" },
  ],
  "Tonno Cipolla Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Tuna", qty: 26, unit: "g" },
    { name: "Onion", qty: 8, unit: "g" },
  ],
  "Tonno Cipolla Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Tuna", qty: 40, unit: "g" },
    { name: "Onion", qty: 16, unit: "g" },
  ],
  "Veggie Pizza 10 inch": [
    { name: "10inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 45, unit: "g" },
    { name: "Mozzarella Blend", qty: 90, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Bell Pepper", qty: 8, unit: "g" },
    { name: "Mushroom Packet", qty: 0.4, unit: "pcs" },
  ],
  "Veggie Pizza 12 inch": [
    { name: "12inch Dough Ball", qty: 1, unit: "pcs" },
    { name: "Pizza Sauce Batch", qty: 90, unit: "g" },
    { name: "Mozzarella Blend", qty: 150, unit: "g" },
    { name: "Oregano", qty: 0.3333, unit: "g" },
    { name: "Bell Pepper", qty: 16, unit: "g" },
    { name: "Mushroom Packet", qty: 0.5, unit: "pcs" },
  ],
};

export const PREPS: Readonly<Record<string, Prep>> = {
  "10inch Dough Ball": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Pizza Dough Batch", qty: 0.0476, unit: "pcs" },
    ],
  },
  "12inch Dough Ball": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Pizza Dough Batch", qty: 0.0833, unit: "pcs" },
    ],
  },
  "Alfredo Chicken Master Batch": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Raw Deboned Chicken", qty: 1600, unit: "g" },
      { name: "Salt", qty: 24, unit: "g" },
      { name: "Pepper", qty: 8, unit: "g" },
      { name: "Garlic", qty: 20, unit: "g" },
      { name: "Onion", qty: 10, unit: "g" },
      { name: "Oregano", qty: 2, unit: "g" },
      { name: "Chili Powder", qty: 10, unit: "g" },
      { name: "Sunflower Oil", qty: 12, unit: "g" },
    ],
  },
  "Alfredo Sauce Master Batch": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Butter", qty: 150, unit: "g" },
      { name: "A/P Flour", qty: 150, unit: "g" },
      { name: "Milk", qty: 1260, unit: "g" },
      { name: "Parmesan", qty: 200, unit: "g" },
      { name: "Turmeric", qty: 2.25, unit: "g" },
      { name: "Pepper", qty: 6.25, unit: "g" },
      { name: "MSG", qty: 6, unit: "g" },
      { name: "Garlic Powder", qty: 1.75, unit: "g" },
      { name: "Ginger Powder", qty: 1.75, unit: "g" },
      { name: "Paprika", qty: 2, unit: "g" },
      { name: "Thyme", qty: 1.25, unit: "g" },
      { name: "Bay Leaf", qty: 0.87, unit: "g" },
      { name: "Oregano", qty: 0.87, unit: "g" },
      { name: "Rosemary", qty: 1.87, unit: "g" },
      { name: "Salt", qty: 12.5, unit: "g" },
      { name: "Olive Oil", qty: 48, unit: "g" },
    ],
  },
  "Bolognese Sauce Master Batch": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Tomato", qty: 1200, unit: "g" },
      { name: "Tomato Paste", qty: 350, unit: "g" },
      { name: "Fresh Garlic", qty: 200, unit: "g" },
      { name: "Fresh Onion", qty: 400, unit: "g" },
      { name: "Milk", qty: 630, unit: "g" },
      { name: "Parmesan", qty: 40, unit: "g" },
      { name: "Pepper", qty: 9.37, unit: "g" },
      { name: "MSG", qty: 5.6, unit: "g" },
      { name: "Garlic Powder", qty: 1.75, unit: "g" },
      { name: "Ginger Powder", qty: 1.75, unit: "g" },
      { name: "Paprika", qty: 2, unit: "g" },
      { name: "Thyme", qty: 1.25, unit: "g" },
      { name: "Bay Leaf", qty: 0.87, unit: "g" },
      { name: "Oregano", qty: 0.87, unit: "g" },
      { name: "Rosemary", qty: 1.87, unit: "g" },
      { name: "Salt", qty: 15, unit: "g" },
      { name: "Olive Oil", qty: 48, unit: "g" },
    ],
  },
  "Crispy Chicken Breading Mix Batch": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "A/P Flour", qty: 232, unit: "g" },
      { name: "Corn Flour", qty: 58, unit: "g" },
      { name: "Salt", qty: 10, unit: "g" },
      { name: "MSG", qty: 3, unit: "g" },
      { name: "Garlic Powder", qty: 1.4, unit: "g" },
      { name: "Paprika", qty: 1.6, unit: "g" },
      { name: "Pepper", qty: 2.5, unit: "g" },
      { name: "Oregano", qty: 0.7, unit: "g" },
      { name: "Turmeric", qty: 1, unit: "g" },
      { name: "Onion Powder", qty: 1.4, unit: "g" },
    ],
  },
  "Crispy Chicken Seasoning Mix Batch": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Curd", qty: 1000, unit: "g" },
      { name: "Salt", qty: 5, unit: "g" },
      { name: "Sugar", qty: 12, unit: "g" },
      { name: "MSG", qty: 4.5, unit: "g" },
      { name: "Fresh Garlic", qty: 15, unit: "g" },
      { name: "Fresh Ginger", qty: 6, unit: "g" },
      { name: "Chili Powder", qty: 2.5, unit: "g" },
    ],
  },
  "Mozzarella Blend": {
    makes: null,
    lines: [
      { name: "Mozzarella A", qty: 1000, unit: "g" },
      { name: "Mozzarella B", qty: 1000, unit: "g" },
    ],
  },
  "Penne Boil Batch": {
    makes: null,
    lines: [
      { name: "Dry Penne", qty: 1600, unit: "g" },
      { name: "Sunflower Oil", qty: 24, unit: "g" },
      { name: "Salt", qty: 40, unit: "g" },
    ],
  },
  "Pizza Dough Batch": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Pizza Dough Culture", qty: 1, unit: "pcs" },
      { name: "Pizza Flour", qty: 2550, unit: "g" },
      { name: "Salt", qty: 31.095, unit: "g" },
      { name: "Water", qty: 1494, unit: "g" },
      { name: "Sunflower Oil", qty: 85, unit: "g" },
    ],
  },
  "Pizza Dough Culture": {
    makes: { qty: 1, unit: "pcs" },
    lines: [
      { name: "Pizza Flour", qty: 122, unit: "g" },
      { name: "Yeast", qty: 3.93, unit: "g" },
      { name: "Sugar", qty: 6.11, unit: "g" },
      { name: "Water", qty: 200, unit: "g" },
    ],
  },
  "Pizza Sauce Batch": {
    makes: null,
    lines: [
      { name: "Peeled Tomato", qty: 2550, unit: "g" },
      { name: "Tomato Paste", qty: 550, unit: "g" },
      { name: "Water", qty: 500, unit: "g" },
      { name: "Oregano", qty: 3.12, unit: "g" },
      { name: "Basil", qty: 3.12, unit: "g" },
      { name: "Salt", qty: 13.82, unit: "g" },
      { name: "Pepper", qty: 9.75, unit: "g" },
    ],
  },
  "Spaghetti Boil Batch": {
    makes: null,
    lines: [
      { name: "Dry Spaghetti", qty: 1600, unit: "g" },
      { name: "Sunflower Oil", qty: 24, unit: "g" },
      { name: "Salt", qty: 40, unit: "g" },
    ],
  },
};
