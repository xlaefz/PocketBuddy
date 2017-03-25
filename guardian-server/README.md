# Guardian (Server)
> The server-side compontent to [Guardian](http://devpost.com/software/guardian-652ibf)

![guardian](http://challengepost-s3-challengepost.netdna-ssl.com/photos/production/software_photos/000/289/011/datas/gallery.jpg)

## Gist of the Algorithm

1. Get the estimated wait time from Uber
2. Generate a list of lat/lng pairs around the user in increments of a few degrees and plus or minus a few m/s
3. Snap those points to the nearest roads (thanks Google Maps API)
4. Take each of those points and find out how long it'll take to walk there from the original location (thanks again Google)
5. Find the route/location pair that most closely matches where you'll be.
6. Order the Uber to that location
7. Call the Uber driver and let them know what's up.
8. Texts your friend to let them know you're walking to an Uber.

The fun part starts at [index.js#126](index.js#L126)
