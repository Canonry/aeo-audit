import type { StructuredDataEntry } from './types.js'

/**
 * schema.org LocalBusiness and its subtypes: a business at a physical place,
 * such as a Hotel, Restaurant or Dentist. Organization is not one of them; it
 * is usually a publisher or parent brand. Kept out of the package exports.
 */
const LOCAL_BUSINESS_TYPES: ReadonlySet<string> = new Set(`
  LocalBusiness AnimalShelter ArchiveOrganization ChildCare DryCleaningOrLaundry
  EmploymentAgency InternetCafe Library ProfessionalService RadioStation RealEstateAgent
  RecyclingCenter SelfStorage ShoppingCenter TelevisionStation TouristInformationCenter
  TravelAgency
  AutomotiveBusiness AutoBodyShop AutoDealer AutoPartsStore AutoRental AutoRepair AutoWash
  GasStation MotorcycleDealer MotorcycleRepair
  EmergencyService FireStation Hospital PoliceStation
  EntertainmentBusiness AdultEntertainment AmusementPark ArtGallery Casino ComedyClub
  MovieTheater NightClub
  FinancialService AccountingService AutomatedTeller BankOrCreditUnion InsuranceAgency
  FoodEstablishment Bakery BarOrPub Brewery CafeOrCoffeeShop Distillery FastFoodRestaurant
  IceCreamShop Restaurant Winery
  GovernmentOffice PostOffice
  HealthAndBeautyBusiness BeautySalon DaySpa HairSalon HealthClub NailSalon TattooParlor
  HomeAndConstructionBusiness Electrician GeneralContractor HVACBusiness HousePainter
  Locksmith MovingCompany Plumber RoofingContractor
  LegalService Attorney Notary
  LodgingBusiness BedAndBreakfast Campground Hostel Hotel Motel Resort SkiResort VacationRental
  MedicalBusiness CommunityHealth Dentist Dermatology DietNutrition Emergency Geriatric
  Gynecologic MedicalClinic CovidTestingFacility Midwifery Nursing Obstetric Oncologic
  Optician Optometric Otolaryngologic Pediatric Pharmacy Physician IndividualPhysician
  PhysiciansOffice Physiotherapy PlasticSurgery Podiatric PrimaryCare Psychiatric PublicHealth
  SportsActivityLocation BowlingAlley ExerciseGym GolfCourse PublicSwimmingPool SportsClub
  StadiumOrArena TennisComplex
  Store BikeStore BookStore ClothingStore ComputerStore ConvenienceStore DepartmentStore
  ElectronicsStore Florist FurnitureStore GardenStore GroceryStore HardwareStore HobbyShop
  HomeGoodsStore JewelryStore LiquorStore MensClothingStore MobilePhoneStore MovieRentalStore
  MusicStore OfficeEquipmentStore OutletStore PawnShop PetStore ShoeStore SportingGoodsStore
  TireShop ToyStore WholesaleStore
`.split(/\s+/).filter(Boolean))

/** The node's first LocalBusiness-family type, given as a bare name or a schema.org URL. */
export function localBusinessType(node: StructuredDataEntry): string | undefined {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']]
  for (const type of types) {
    if (typeof type !== 'string') continue
    const bare = type.trim().replace(/^(?:https?:\/\/schema\.org\/|schema:)/i, '')
    if (LOCAL_BUSINESS_TYPES.has(bare)) return bare
  }
  return undefined
}

/**
 * LocalBusiness-family nodes the page itself declares: top level, `@graph`
 * members, and a page's `mainEntity` or `about`. Deeper nodes, such as an
 * Offer's `seller` or a Review's `itemReviewed`, are usually references to
 * some other business and are left out.
 */
export function pageBusinessNodes(structuredData: StructuredDataEntry[]): { node: StructuredDataEntry; type: string }[] {
  const seen = new Set<object>()
  const nodes: { node: StructuredDataEntry; type: string }[] = []
  const consider = (value: unknown): void => {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue
      const type = localBusinessType(candidate as StructuredDataEntry)
      if (!type) continue
      seen.add(candidate)
      nodes.push({ node: candidate as StructuredDataEntry, type })
    }
  }
  for (const item of structuredData) {
    consider(item)
    consider(item.mainEntity)
    consider(item.about)
  }
  return nodes
}
