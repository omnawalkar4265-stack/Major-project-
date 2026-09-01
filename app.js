if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}

const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const Review = require("./models/review.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const session = require("express-session");
const mongoStore = require("connect-mongo").default;
const db_url = process.env.ATLASDB_URL;
const passport = require("passport");
const LocalStrategy = require("passport-local");
const User = require("./models/user.js");

const thunderforestKey = process.env.THUNDERFOREST_API_KEY;

const multer = require("multer");
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "public/uploads"));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage: storage });

main()
  .then(() => {
    console.log("connected to DB");
  })
  .catch((err) => {
    console.log(err);
  });

async function main() {
  await mongoose.connect(db_url);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, "/public")));

const sessionOptions = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
  },
};

// Temporarily disabled to test MongoDB connection issue
// const store = mongoStore.create({
//   mongoUrl: db_url,
//   secret: process.env.SESSION_SECRET,
//   touchAfter: 24 * 3600,
// });

// store.on("error", (err) => {
//   console.log("Session store error:", err);
// });

// sessionOptions.store = store;

app.use(session(sessionOptions));
app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

// Helper: convert "location, country" text into [longitude, latitude]
async function geocodeLocation(location, country) {
  const query = encodeURIComponent(`${location}, ${country}`);
  const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;

  const response = await fetch(url, {
    headers: { "User-Agent": "WanderlustApp/1.0" }
  });
  const data = await response.json();

  if (data && data.length > 0) {
    return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
  }
  return [0, 0];
}

app.get("/", (req, res) => {
  res.redirect("/listings");
});

app.get("/listings", async (req, res) => {
  const allListings = await Listing.find({});
  res.render("listings/index.ejs", { allListings });
});

app.get("/listings/new", (req, res) => {
  res.render("listings/new.ejs");
});

app.get("/listings/:id", async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id).populate("reviews");
  res.render("listings/show.ejs", { listing, thunderforestKey });
});

app.post("/listings", upload.single("listing[image]"), async (req, res) => {
  const data = req.body.listing;

  if (!data.title || data.title.trim() === "") {
    return res.send("❌ Title is required");
  }

  const newListing = new Listing(data);

  if (req.file) {
    newListing.image = {
      url: "/uploads/" + req.file.filename,
      filename: req.file.filename,
    };
  }

  try {
    const coordinates = await geocodeLocation(data.location, data.country);
    newListing.geometry = {
      type: "Point",
      coordinates: coordinates,
    };
  } catch (e) {
    console.log("Geocoding failed:", e.message);
  }

  await newListing.save();

  res.redirect("/listings");
});

app.get("/listings/:id/edit", async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id);
  res.render("listings/edit.ejs", { listing });
});

app.put("/listings/:id", upload.single("listing[image]"), async (req, res) => {
  let { id } = req.params;
  let updatedData = req.body.listing;

  if (req.file) {
    updatedData.image = {
      url: "/uploads/" + req.file.filename,
      filename: req.file.filename,
    };
  } else {
    delete updatedData.image;
  }

  try {
    const coordinates = await geocodeLocation(updatedData.location, updatedData.country);
    updatedData.geometry = {
      type: "Point",
      coordinates: coordinates,
    };
  } catch (e) {
    console.log("Geocoding failed:", e.message);
  }

  await Listing.findByIdAndUpdate(id, { $set: updatedData });
  res.redirect(`/listings/${id}`);
});

app.delete("/listings/:id", async (req, res) => {
  let { id } = req.params;
  let deletedListing = await Listing.findByIdAndDelete(id);
  console.log(deletedListing);
  res.redirect("/listings");
});

app.post("/listings/:id/reviews", async (req, res) => {
  let listing = await Listing.findById(req.params.id);
  let newReview = new Review(req.body.review);

  listing.reviews.push(newReview);

  await newReview.save();
  await listing.save();

  res.redirect(`/listings/${listing._id}`);
});

app.delete("/listings/:id/reviews/:reviewId", async (req, res) => {
  let { id, reviewId } = req.params;

  await Listing.findByIdAndUpdate(id, { $pull: { reviews: reviewId } });
  await Review.findByIdAndDelete(reviewId);

  res.redirect(`/listings/${id}`);
});

app.get("/signup", (req, res) => {
  res.render("user/signup", { error: null });
});

app.post("/signup", async (req, res) => {
  try {
    let { username, email, password } = req.body;
    const newUser = new User({ username, email });
    await User.register(newUser, password);
    res.redirect("/login");
  } catch (e) {
    res.render("user/signup", { error: e.message });
  }
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.render("login", { error: "Incorrect username or password" });
    }
    req.logIn(user, (err) => {
      if (err) return next(err);
      return res.redirect("/listings");
    });
  })(req, res, next);
});

app.listen(8080, () => {
  console.log("Server is running on port 8080");
  console.log("Visit: http://localhost:8080/listings");
});