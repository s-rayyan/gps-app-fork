let map;
let directionsService;
let directionsRenderer;
let placesService;
let stopMarkers = [];

function initMap() {
  // Initial center (US center-ish); will recenter on route
  const initialCenter = { lat: 39.8283, lng: -98.5795 };

  map = new google.maps.Map(document.getElementById("map"), {
    center: initialCenter,
    zoom: 4,
  });

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    map,
    suppressMarkers: false,
  });

  placesService = new google.maps.places.PlacesService(map);

  const form = document.getElementById("trip-form");
  form.addEventListener("submit", handlePlanTrip);
}

async function handlePlanTrip(event) {
  event.preventDefault();
  clearError();
  clearStops();

  const origin = document.getElementById("origin").value.trim();
  const destination = document.getElementById("destination").value.trim();
  const rangeMiles = Number(document.getElementById("range").value);
  const reserveMiles = Number(document.getElementById("reserve").value || 0);

  if (!origin || !destination || !rangeMiles || rangeMiles <= 0) {
    showError("Please fill in origin, destination, and a valid range.");
    return;
  }

  if (reserveMiles >= rangeMiles) {
    showError("Reserve buffer must be less than the range per tank.");
    return;
  }

  const usableRange = rangeMiles - reserveMiles;
  if (usableRange < 30) {
    showError("Usable range is too small. Increase range or decrease reserve.");
    return;
  }

  setPlanning(true);

  try {
    const route = await getRoute(origin, destination);
    directionsRenderer.setDirections(route);

    const totalDistanceMiles = computeTotalDistanceMiles(route);
    const stopPlan = computeStopPoints(route, usableRange);

    if (stopPlan.length === 0) {
      renderResultsNoStops(totalDistanceMiles, rangeMiles);
    } else {
      const gasStops = await findGasStationsForStops(stopPlan);
      renderResultsWithStops(totalDistanceMiles, rangeMiles, gasStops);
      addStopMarkers(gasStops);
    }
  } catch (err) {
    console.error(err);
    showError(err.message || "Failed to plan trip. Try again.");
  } finally {
    setPlanning(false);
  }
}

function getRoute(origin, destination) {
  return new Promise((resolve, reject) => {
    directionsService.route(
      {
        origin,
        destination,
        travelMode: google.maps.TravelMode.DRIVING,
        provideRouteAlternatives: false,
      },
      (result, status) => {
        if (status === google.maps.DirectionsStatus.OK) {
          resolve(result);
        } else {
          reject(new Error("Could not fetch route. Check locations and try again."));
        }
      }
    );
  });
}

function computeTotalDistanceMiles(routeResult) {
  const route = routeResult.routes[0];
  let meters = 0;
  route.legs.forEach((leg) => {
    meters += leg.distance.value;
  });
  return meters / 1609.344;
}

/**
 * Walk along the route and place "ideal stop points" every usableRange miles.
 * Returns an array of:
 *   { latLng: google.maps.LatLng, distanceFromStartMiles: number }
 */
function computeStopPoints(routeResult, usableRangeMiles) {
  const route = routeResult.routes[0];
  const legs = route.legs;

  const stopPoints = [];
  let distanceSinceLastStop = 0;
  let cumulativeMiles = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];

    for (let j = 0; j < leg.steps.length; j++) {
      const step = leg.steps[j];
      const stepMeters = step.distance.value;
      const stepMiles = stepMeters / 1609.344;

      // The step has a start + end LatLng; we’ll interpolate in between
      const startLatLng = step.start_location;
      const endLatLng = step.end_location;

      let remainingStepMiles = stepMiles;
      // Unit vector for interpolation
      const latDiff = (endLatLng.lat() - startLatLng.lat()) / stepMiles;
      const lngDiff = (endLatLng.lng() - startLatLng.lng()) / stepMiles;

      while (remainingStepMiles > 0) {
        const distanceToNextStop = usableRangeMiles - distanceSinceLastStop;

        if (distanceToNextStop <= remainingStepMiles) {
          // Place a stop in this step
          cumulativeMiles += distanceToNextStop;
          distanceSinceLastStop = 0;
          remainingStepMiles -= distanceToNextStop;

          const t = distanceToNextStop; // since we're in miles "along" the step
          const stopLat = startLatLng.lat() + latDiff * t;
          const stopLng = startLatLng.lng() + lngDiff * t;

          stopPoints.push({
            latLng: new google.maps.LatLng(stopLat, stopLng),
            distanceFromStartMiles: cumulativeMiles,
          });
        } else {
          // No stop yet, just progress
          distanceSinceLastStop += remainingStepMiles;
          cumulativeMiles += remainingStepMiles;
          remainingStepMiles = 0;
        }
      }
    }
  }

  return stopPoints;
}

function findGasStationsForStops(stopPoints) {
  const searchRadiusMeters = 8000; // ~5 miles

  const promises = stopPoints.map(
    (stop, index) =>
      new Promise((resolve) => {
        placesService.nearbySearch(
          {
            location: stop.latLng,
            radius: searchRadiusMeters,
            type: ["gas_station"],
          },
          (results, status) => {
            if (status === google.maps.places.PlacesServiceStatus.OK && results.length > 0) {
              const top = results[0];
              resolve({
                index: index + 1,
                stopDistanceFromStart: stop.distanceFromStartMiles,
                position: top.geometry.location,
                name: top.name,
                address: top.vicinity || top.formatted_address || "",
                rating: top.rating || null,
                userRatingsTotal: top.user_ratings_total || null,
              });
            } else {
              resolve({
                index: index + 1,
                stopDistanceFromStart: stop.distanceFromStartMiles,
                position: stop.latLng,
                name: "Gas station not found nearby",
                address: "Try expanding search radius or stopping earlier.",
                rating: null,
                userRatingsTotal: null,
              });
            }
          }
        );
      })
  );

  return Promise.all(promises);
}

function addStopMarkers(stops) {
  stopMarkers.forEach((m) => m.setMap(null));
  stopMarkers = [];

  stops.forEach((stop) => {
    const marker = new google.maps.Marker({
      position: stop.position,
      map,
      label: `${stop.index}`,
      title: stop.name,
    });
    stopMarkers.push(marker);
  });
}

function clearStops() {
  stopMarkers.forEach((m) => m.setMap(null));
  stopMarkers = [];
  document.getElementById("results").innerHTML = "";
}

function setPlanning(isPlanning) {
  const btn = document.getElementById("plan-btn");
  btn.disabled = isPlanning;
  btn.textContent = isPlanning ? "Planning..." : "Plan gas stops";
}

function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
}

function clearError() {
  document.getElementById("error").textContent = "";
}

function renderResultsNoStops(totalDistanceMiles, rangeMiles) {
  const results = document.getElementById("results");
  const total = totalDistanceMiles.toFixed(1);

  results.innerHTML = `
    <div class="result-summary">
      Total trip distance: <strong>${total} miles</strong><br/>
      With a range of ~${rangeMiles.toFixed(0)} miles, you <strong>don't need any fuel stops</strong> on this route.
    </div>
  `;
}

function renderResultsWithStops(totalDistanceMiles, rangeMiles, stops) {
  const results = document.getElementById("results");
  const total = totalDistanceMiles.toFixed(1);
  const stopCount = stops.length;

  let html = `
    <div class="result-summary">
      Total trip distance: <strong>${total} miles</strong><br/>
      Estimated fuel stops needed: <strong>${stopCount}</strong> (range ≈ ${rangeMiles.toFixed(0)} mi)
    </div>
  `;

  stops.forEach((stop) => {
    const dist = stop.stopDistanceFromStart.toFixed(1);
    const ratingText =
      stop.rating != null
        ? `Rating: ${stop.rating.toFixed(1)} (${stop.userRatingsTotal || 0} reviews)`
        : "";

    html += `
      <div class="stop-card">
        <div class="stop-title">Stop #${stop.index}: ${stop.name}</div>
        <div class="stop-meta">${stop.address}</div>
        <div class="stop-distance">Distance from start: ~${dist} miles</div>
        ${ratingText ? `<div class="stop-meta">${ratingText}</div>` : ""}
      </div>
    `;
  });

  results.innerHTML = html;
}
