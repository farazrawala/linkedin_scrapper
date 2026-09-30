/**
 * Job Post Finder — place names looked for in job posts (used by shared.js).
 *
 * Matched case-sensitively as whole words, so "Nice" or "Reading" in normal
 * sentences don't count unless listed here. Add your own entries freely.
 */
const LOCATION_PLACES = [
  // Gulf / Middle East
  "UAE", "United Arab Emirates", "Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Fujairah",
  "Saudi Arabia", "KSA", "Riyadh", "Jeddah", "Dammam", "Khobar", "Al Khobar", "NEOM", "Mecca", "Makkah", "Medina",
  "Qatar", "Doha", "Bahrain", "Manama", "Kuwait", "Kuwait City", "Oman", "Muscat",
  "Egypt", "Cairo", "Jordan", "Amman", "Lebanon", "Beirut", "Turkey", "Türkiye", "Istanbul", "Ankara",
  "GCC", "MENA", "Middle East",

  // South Asia
  "Pakistan", "Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Peshawar", "Multan", "Quetta", "Sialkot", "Hyderabad, Pakistan",
  "India", "Bangalore", "Bengaluru", "Mumbai", "Delhi", "New Delhi", "Gurgaon", "Gurugram", "Noida", "Hyderabad",
  "Chennai", "Pune", "Kolkata", "Ahmedabad", "Jaipur", "Kochi", "Indore", "Chandigarh",
  "Bangladesh", "Dhaka", "Sri Lanka", "Colombo", "Nepal", "Kathmandu",

  // North America
  "USA", "United States", "U.S.", "New York", "NYC", "San Francisco", "Bay Area", "Silicon Valley", "Seattle", "Austin",
  "Boston", "Chicago", "Los Angeles", "Miami", "Denver", "Atlanta", "Dallas", "Houston", "Washington DC", "San Diego",
  "Canada", "Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary", "Mexico", "Mexico City",

  // Europe
  "UK", "United Kingdom", "England", "London", "Manchester", "Birmingham", "Edinburgh", "Glasgow",
  "Ireland", "Dublin", "Germany", "Berlin", "Munich", "Hamburg", "Frankfurt", "Netherlands", "Amsterdam", "Rotterdam",
  "France", "Paris", "Spain", "Madrid", "Barcelona", "Portugal", "Lisbon", "Porto", "Italy", "Milan", "Rome",
  "Poland", "Warsaw", "Krakow", "Sweden", "Stockholm", "Norway", "Oslo", "Denmark", "Copenhagen", "Finland", "Helsinki",
  "Switzerland", "Zurich", "Geneva", "Austria", "Vienna", "Belgium", "Brussels", "Czech Republic", "Prague",
  "Romania", "Bucharest", "Estonia", "Tallinn", "Europe", "EMEA",

  // Asia-Pacific
  "Singapore", "Malaysia", "Kuala Lumpur", "Indonesia", "Jakarta", "Bali", "Philippines", "Manila", "Vietnam",
  "Ho Chi Minh City", "Hanoi", "Thailand", "Bangkok", "Japan", "Tokyo", "South Korea", "Seoul", "China", "Shanghai",
  "Beijing", "Shenzhen", "Hong Kong", "Taiwan", "Australia", "Sydney", "Melbourne", "Brisbane", "Perth",
  "New Zealand", "Auckland", "APAC",

  // Africa
  "Nigeria", "Lagos", "Kenya", "Nairobi", "South Africa", "Cape Town", "Johannesburg", "Morocco", "Casablanca",
  "Ghana", "Accra", "Rwanda", "Kigali",
];
