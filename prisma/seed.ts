import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Wiping database for clean seed...");

  await prisma.quizAnswer.deleteMany();
  await prisma.quizAttempt.deleteMany();
  await prisma.moduleProgress.deleteMany();
  await prisma.classTopic.deleteMany();
  await prisma.classEnrollment.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.option.deleteMany();
  await prisma.question.deleteMany();
  await prisma.subtopic.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.class.deleteMany();
  await prisma.student.deleteMany();
  await prisma.teacher.deleteMany();
  await prisma.user.deleteMany();

  console.log("Database wiped. Seeding fresh data...");

  const topic = await prisma.topic.create({
    data: { id: "thermodynamics", name: "Thermodynamics", order: 1 },
  });

  console.log(`Topic: ${topic.name}`);

  const subtopicData = [
    { id: "nature-of-temperature", name: "Nature of temperature", order: 1 },
    { id: "heat-transfer-change", name: "Heat transfer and temperature change", order: 2 },
    { id: "heat-transfer-material", name: "Heat transfer and material", order: 3 },
    { id: "fusion-melting-freezing", name: "Fusion/melting point and freezing point", order: 4 },
    { id: "boiling-liquifaction-vaporation", name: "Boiling point, Liquifaction, Vaporation", order: 5 },
  ];

  for (const s of subtopicData) {
    const subtopic = await prisma.subtopic.create({
      data: { id: s.id, name: s.name, order: s.order, topicId: topic.id },
    });
    console.log(`  Subtopic: ${subtopic.name}`);
  }

  type QuestionData = {
    text: string;
    subtopicId: string;
    difficulty: string;
    options: { text: string; isCorrect: boolean }[];
  };

  const questionsData: QuestionData[] = [
    {
      text: "What is the most likely temperature of ice-cubes stored in a refrigerator's freezer compartment?",
      subtopicId: "fusion-melting-freezing",
      difficulty: "BEGINNER",
      options: [
        { text: "−10 °C", isCorrect: true },
        { text: "0 °C", isCorrect: false },
        { text: "5 °C", isCorrect: false },
        { text: "It depends on the size of the ice-cubes.", isCorrect: false },
      ],
    },
    {
      text: "Ken takes six ice-cubes from the freezer and puts four of them into a glass of water. He leaves two on the bench-top. He stirs and stirs until the ice-cubes are much smaller and have stopped melting. What is the most likely temperature of the water at this stage?",
      subtopicId: "fusion-melting-freezing",
      difficulty: "BEGINNER",
      options: [
        { text: "−10 °C", isCorrect: false },
        { text: "0 °C", isCorrect: true },
        { text: "5 °C", isCorrect: false },
        { text: "10 °C", isCorrect: false },
      ],
    },
    {
      text: "The ice-cubes Ken left on the bench-top have almost melted and are lying in a puddle of water. What is the most likely temperature of these smaller ice-cubes?",
      subtopicId: "fusion-melting-freezing",
      difficulty: "BEGINNER",
      options: [
        { text: "−10 °C", isCorrect: false },
        { text: "0 °C", isCorrect: true },
        { text: "5 °C", isCorrect: false },
        { text: "10 °C", isCorrect: false },
      ],
    },
    {
      text: "On the stove is a kettle full of water. The water has started to boil rapidly. The most likely temperature of the water is about:",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "88 °C", isCorrect: false },
        { text: "98 °C", isCorrect: true },
        { text: "110 °C", isCorrect: false },
        { text: "None of the above answers could be right.", isCorrect: false },
      ],
    },
    {
      text: "Five minutes later, the water in the kettle is still boiling. The most likely temperature of the water now is about:",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "88 °C", isCorrect: false },
        { text: "98 °C", isCorrect: true },
        { text: "110 °C", isCorrect: false },
        { text: "120 °C", isCorrect: false },
      ],
    },
    {
      text: "What do you think is the temperature of the steam above the boiling water in the kettle?",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "88 °C", isCorrect: false },
        { text: "98 °C", isCorrect: true },
        { text: "110 °C", isCorrect: false },
        { text: "120 °C", isCorrect: false },
      ],
    },
    {
      text: "Lee takes two cups of water at 40°C and mixes them with one cup of water at 10°C. What is the most likely temperature of the mixture?",
      subtopicId: "heat-transfer-change",
      difficulty: "BEGINNER",
      options: [
        { text: "20 °C", isCorrect: false },
        { text: "25 °C", isCorrect: false },
        { text: "30 °C", isCorrect: true },
        { text: "50 °C", isCorrect: false },
      ],
    },
    {
      text: "Jim believes he must use boiling water to make a cup of tea. He tells his friends: I couldn't make tea if I was camping on a high mountain because water doesn't boil at high altitudes. Who do you agree with?",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "BEGINNER",
      options: [
        { text: "Joy says: Yes it does, but the boiling water is just not as hot as it is here.", isCorrect: true },
        { text: "Tay says: That's not true. Water always boils at the same temperature.", isCorrect: false },
        { text: "Lou says: The boiling point of the water decreases, but the water itself is still at 100 degrees.", isCorrect: false },
        { text: "Mai says: I agree with Jim. The water never gets to its boiling point.", isCorrect: false },
      ],
    },
    {
      text: "Sam takes a can of cola and a plastic bottle of cola from the refrigerator, where they have been overnight. He quickly puts a thermometer in the cola in the can. The temperature is 7°C. What are the most likely temperatures of the plastic bottle and cola it holds?",
      subtopicId: "nature-of-temperature",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "They are both less than 7°C", isCorrect: false },
        { text: "They are both equal to 7°C", isCorrect: true },
        { text: "They are both greater than 7°C", isCorrect: false },
        { text: "The cola is at 7°C but the bottle is greater than 7°C", isCorrect: false },
        { text: "It depends on the amount of cola and/or the size of the bottle.", isCorrect: false },
      ],
    },
    {
      text: "A few minutes later, Ned picks up the cola can and then tells everyone that the bench top underneath it feels colder than the rest of the bench. Whose explanation do you think is best?",
      subtopicId: "heat-transfer-change",
      difficulty: "BEGINNER",
      options: [
        { text: "Jon says: The cold has been transferred from the cola to the bench.", isCorrect: false },
        { text: "Rob says: There is no energy left in the bench beneath the can.", isCorrect: false },
        { text: "Sue says: Some heat has been transferred from the bench to the cola.", isCorrect: true },
        { text: "Eli says: The can causes heat beneath the can to move away through the bench-top.", isCorrect: false },
      ],
    },
    {
      text: "Pam asks: If I put 100 grams of ice at 0°C and 100 grams of water at 0°C into a freezer, which one will eventually lose the greatest amount of heat? Which of her friends do you most agree with?",
      subtopicId: "fusion-melting-freezing",
      difficulty: "BEGINNER",
      options: [
        { text: "Cat says: The 100 grams of ice.", isCorrect: false },
        { text: "Ben says: The 100 grams of water.", isCorrect: true },
        { text: "Nic says: Neither because they both contain the same amount of heat.", isCorrect: false },
        { text: "Mat says: There's no answer, because ice doesn't contain any heat.", isCorrect: false },
        { text: "Jed says: There's no answer, because you can't get water at 0°C.", isCorrect: false },
      ],
    },
    {
      text: "Mel is boiling water in a saucepan on the stovetop. What do you think is in the bubbles that form in the boiling water? Mostly:",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "Air", isCorrect: false },
        { text: "Oxygen and hydrogen gas", isCorrect: false },
        { text: "Water vapour", isCorrect: true },
        { text: "There's nothing in the bubbles.", isCorrect: false },
      ],
    },
    {
      text: "After cooking some eggs in the boiling water, Mel cools the eggs by putting them into a bowl of cold water. Which of the following explains the cooling process?",
      subtopicId: "heat-transfer-change",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "Temperature is transferred from the eggs to the water.", isCorrect: false },
        { text: "Cold moves from the water into the eggs.", isCorrect: false },
        { text: "Hot objects naturally cool down.", isCorrect: false },
        { text: "Energy is transferred from the eggs to the water.", isCorrect: true },
      ],
    },
    {
      text: "Jan announces that she does not like sitting on the metal chairs in the room because they are colder than the plastic ones. Who do you think is right?",
      subtopicId: "heat-transfer-material",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "Jim agrees and says: They are colder because metal is naturally colder than plastic.", isCorrect: false },
        { text: "Kip says: They are not colder, they are at the same temperature.", isCorrect: true },
        { text: "Lou says: They are not colder, the metal ones just feel colder because they are heavier.", isCorrect: false },
        { text: "Mai says: They are colder because metal has less heat to lose than plastic.", isCorrect: false },
      ],
    },
    {
      text: "A group is listening to the weather forecast on a radio. They hear: tonight it will be a chilly 5°C, colder than the 10°C it was last night. Whose statement do you most agree with?",
      subtopicId: "nature-of-temperature",
      difficulty: "BEGINNER",
      options: [
        { text: "Jen says: That means it will be twice as cold tonight as it was last night.", isCorrect: false },
        { text: "Ali says: That's not right. 5°C is not twice as cold as 10°C.", isCorrect: true },
        { text: "Raj says: It's partly right, but she should have said that 10°C is twice as warm as 5°C.", isCorrect: false },
        { text: "Guy says: It's partly right, but she should have said that 5°C is half as cold as 10°C.", isCorrect: false },
      ],
    },
    {
      text: "Kim takes a metal ruler and a wooden ruler from his pencil case. He announces that the metal one feels colder than the wooden one. What is your preferred explanation?",
      subtopicId: "heat-transfer-material",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "Metal conducts energy away from his hand more rapidly than wood.", isCorrect: true },
        { text: "Wood is a naturally warmer substance than metal.", isCorrect: false },
        { text: "The wooden ruler contains more heat than the metal ruler.", isCorrect: false },
        { text: "Metals are better heat radiators than wood.", isCorrect: false },
        { text: "Cold flows more readily from a metal.", isCorrect: false },
      ],
    },
    {
      text: "Amy took two glass bottles containing water at 20°C and wrapped them in towelling washcloths. One was wet, the other was dry. 20 minutes later, the wet cloth bottle was 18°C, the dry cloth bottle was 22°C. The most likely room temperature during this experiment was:",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "26°C", isCorrect: true },
        { text: "21°C", isCorrect: false },
        { text: "20°C", isCorrect: false },
        { text: "18°C", isCorrect: false },
      ],
    },
    {
      text: "Dan simultaneously picks up two cartons of chocolate milk, a cold one from the refrigerator and a warm one from the bench-top. Why do you think the carton from the refrigerator feels colder? Compared with the warm carton, the cold carton:",
      subtopicId: "heat-transfer-change",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "contains more cold.", isCorrect: false },
        { text: "contains less heat.", isCorrect: false },
        { text: "is a poorer heat conductor.", isCorrect: false },
        { text: "conducts heat more rapidly from Dan's hand.", isCorrect: true },
        { text: "conducts cold more rapidly to Dan's hand.", isCorrect: false },
      ],
    },
    {
      text: "Ron reckons his mother cooks soup in a pressure cooker because it cooks faster. Pressure cookers have a sealed lid so that the pressure inside rises well above atmospheric pressure. Which person do you most agree with?",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "Emi says: It's because the pressure causes water to boil above 100°C.", isCorrect: true },
        { text: "Col says: It's because the high pressure generates extra heat.", isCorrect: false },
        { text: "Fay says: It's because the steam is at a higher temperature than the boiling soup.", isCorrect: false },
        { text: "Tom says: It's because pressure cookers spread the heat more evenly through the food.", isCorrect: false },
      ],
    },
    {
      text: "Pat believes her Dad cooks cakes on the top shelf inside the electric oven because it is hotter at the top than at the bottom. Which person do you think is right?",
      subtopicId: "nature-of-temperature",
      difficulty: "BEGINNER",
      options: [
        { text: "Pam says that it's hotter at the top because heat rises.", isCorrect: false },
        { text: "Sam says that it is hotter because metal trays concentrate the heat.", isCorrect: false },
        { text: "Ray says it's hotter at the top because the hotter the air the less dense it is.", isCorrect: true },
        { text: "Tim disagrees with them all and says that it's not possible to be hotter at the top.", isCorrect: false },
      ],
    },
    {
      text: "Bev is reading a multiple-choice question: Sweating cools you down because the sweat lying on your skin... Which answer would you tell her to select?",
      subtopicId: "boiling-liquifaction-vaporation",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "wets the surface, and wet surfaces draw more heat out than dry surfaces.", isCorrect: false },
        { text: "drains heat from the pores and spreads it out over the surface of the skin.", isCorrect: false },
        { text: "is the same temperature as your skin but is evaporating and so is carrying heat away.", isCorrect: false },
        { text: "is slightly cooler than your skin because of evaporation and so heat is transferred from your skin to the sweat.", isCorrect: true },
      ],
    },
    {
      text: "When Zac uses a bicycle pump to pump up his bike tyres, he notices that the pump becomes quite hot. Which explanation below seems to be the best one?",
      subtopicId: "heat-transfer-change",
      difficulty: "BEGINNER",
      options: [
        { text: "Energy has been transferred to the pump.", isCorrect: true },
        { text: "Temperature has been transferred to the pump.", isCorrect: false },
        { text: "Heat flows from his hands to the pump.", isCorrect: false },
        { text: "The metal in the pump causes the temperature to rise.", isCorrect: false },
      ],
    },
    {
      text: "Why do we wear sweaters in cold weather?",
      subtopicId: "heat-transfer-material",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "To keep cold out.", isCorrect: false },
        { text: "To generate heat.", isCorrect: false },
        { text: "To reduce heat loss.", isCorrect: true },
        { text: "All three of the above reasons are correct.", isCorrect: false },
      ],
    },
    {
      text: "Vic takes some popsicles from the freezer and tells everyone that the wooden sticks are at a higher temperature than the ice part. Which person do you most agree with?",
      subtopicId: "heat-transfer-material",
      difficulty: "BEGINNER",
      options: [
        { text: "Deb says: You're right because the wooden sticks don't get as cold as ice does.", isCorrect: false },
        { text: "Ian says: You're right because ice contains more cold than wood does.", isCorrect: false },
        { text: "Ros says: You're wrong, they only feel different because the sticks contain more heat.", isCorrect: false },
        { text: "Ann says: I think they are at the same temperature because they are together.", isCorrect: true },
      ],
    },
    {
      text: "Gay is describing a TV segment: I saw physicists make super-conductor magnets, which were at a temperature of -260°C. Who do you think is right?",
      subtopicId: "nature-of-temperature",
      difficulty: "BEGINNER",
      options: [
        { text: "Joe doubts this: You must have made a mistake. You can't have a temperature as low as that.", isCorrect: false },
        { text: "Kay disagrees: Yes you can. There's no limit on the lowest temperature.", isCorrect: false },
        { text: "Leo believes he is right: I think the magnet was near the lowest temperature possible.", isCorrect: true },
        { text: "Gay is not sure: I think super-conductors are good heat conductors so you can't cool them to such a low temperature.", isCorrect: false },
      ],
    },
    {
      text: "Four students were discussing things they did as kids. Ami said: I used to wrap my dolls in blankets but could never understand why they didn't warm up. Who do you agree with?",
      subtopicId: "heat-transfer-material",
      difficulty: "INTERMEDIATE",
      options: [
        { text: "Nic replied: It's because the blankets you used were probably poor insulators.", isCorrect: false },
        { text: "Lyn replied: It's because the blankets you used were probably poor conductors.", isCorrect: false },
        { text: "Jay replied: It's because the dolls were made of material which did not hold heat well.", isCorrect: false },
        { text: "Kev replied: It's because the dolls were made of material which took a long time to warm up.", isCorrect: false },
        { text: "Joy replied: You're all wrong.", isCorrect: true },
      ],
    },
  ];

  for (const q of questionsData) {
    await prisma.question.create({
      data: {
        text: q.text,
        topicId: topic.id,
        subtopicId: q.subtopicId,
        difficultyLevel: q.difficulty,
        options: { create: q.options },
      },
    });
  }
  console.log(`Seeded ${questionsData.length} questions`);
  console.log("\nSeed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
